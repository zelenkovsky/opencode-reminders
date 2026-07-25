import { link, open, readFile, rm } from "node:fs/promises"
import path from "node:path"
import type { PluginInput } from "@opencode-ai/plugin"
import { getStorageDir } from "./storage"

type Owner = {
  pid: number
  marker: string
  start?: string
  token: string
}

export type ExecutionLease = { release: () => Promise<void> }
export type LeaseAcquisition =
  | { status: "acquired"; lease: ExecutionLease }
  | { status: "contended" }
  | { status: "error"; error: unknown }

const processMarker = crypto.randomUUID()
const MUTATION_LOCK_TIMEOUT_MS = 30_000
const MUTATION_LOCK_RETRY_MS = 25

function ownerText(owner: Owner): string {
  return `pid=${owner.pid}\nmarker=${owner.marker}\n${owner.start ? `start=${owner.start}\n` : ""}token=${owner.token}\n`
}

function parseOwner(contents: string): Owner | null {
  const values = new Map(
    contents.split("\n").flatMap((line) => {
      const index = line.indexOf("=")
      return index > 0 ? [[line.slice(0, index), line.slice(index + 1)]] : []
    }),
  )
  const pid = Number(values.get("pid"))
  const marker = values.get("marker")
  const token = values.get("token")
  const start = values.get("start")
  if (!Number.isSafeInteger(pid) || pid <= 0 || !marker || !token) return null
  return { pid, marker, token, ...(start ? { start } : {}) }
}

async function linuxProcessStart(pid: number): Promise<string | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8")
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)
    return fields[19] ?? null
  } catch {
    return null
  }
}

async function ownerIsDemonstrablyDead(owner: Owner): Promise<boolean> {
  if (process.platform === "linux") {
    if (!owner.start) return false
    const currentStart = await linuxProcessStart(owner.pid)
    if (currentStart !== null) return currentStart !== owner.start
  }

  // A missing or unreadable /proc entry is not by itself proof of death: it may
  // reflect permissions, descriptor exhaustion, or a transient I/O failure.
  // kill(pid, 0) lets us reclaim only when the OS specifically reports ESRCH.
  try {
    process.kill(owner.pid, 0)
    return false
  } catch (error: any) {
    return error?.code === "ESRCH"
  }
}

async function createOwnerFile(file: string, owner: Owner): Promise<boolean> {
  const candidate = `${file}.${owner.token}.candidate`
  let handle
  try {
    handle = await open(candidate, "wx", 0o600)
    await handle.writeFile(ownerText(owner))
    await handle.close()
    handle = undefined
    await link(candidate, file)
    return true
  } catch (error: any) {
    if (error?.code === "EEXIST") return false
    throw error
  } finally {
    await handle?.close()
    await rm(candidate, { force: true })
  }
}

async function readOwner(file: string): Promise<Owner | null> {
  try {
    return parseOwner(await readFile(file, "utf8"))
  } catch {
    return null
  }
}

async function recoverDeadOwnerFile(file: string): Promise<boolean> {
  const owner = await readOwner(file)
  if (!owner || !(await ownerIsDemonstrablyDead(owner))) return false
  await rm(file, { force: true })
  return true
}

async function removeStaleLease(lease: string, owner: Owner): Promise<boolean> {
  const recovery = `${lease}.recover`
  // Never reclaim a recovery guard. A crashed recoverer can require manual cleanup,
  // but reclaiming it has a check/unlink race that could delete a live replacement guard.
  if (!(await createOwnerFile(recovery, owner))) return false

  try {
    return await recoverDeadOwnerFile(lease)
  } finally {
    const current = await readOwner(recovery)
    if (current?.token === owner.token) await rm(recovery, { force: true })
  }
}

async function acquireOwnerLock(file: string, owner: Owner): Promise<LeaseAcquisition> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (await createOwnerFile(file, owner)) {
      let released = false
      return {
        status: "acquired",
        lease: {
          async release() {
            if (released) return
            released = true
            const current = await readOwner(file)
            if (current?.token === owner.token) await rm(file, { force: true })
          },
        },
      }
    }
    if (attempt === 0 && await removeStaleLease(file, owner)) continue
    return { status: "contended" }
  }
  return { status: "contended" }
}

async function newOwner(): Promise<Owner> {
  const start = process.platform === "linux" ? await linuxProcessStart(process.pid) : undefined
  return { pid: process.pid, marker: processMarker, token: crypto.randomUUID(), ...(start ? { start } : {}) }
}

export async function acquireExecutionLease(
  reminderID: string,
  occurrence: number,
  ctx: PluginInput,
): Promise<LeaseAcquisition> {
  try {
    const dir = await getStorageDir(ctx)
    const leasePath = path.join(dir, `${reminderID}.${occurrence}.lease`)
    return await acquireOwnerLock(leasePath, await newOwner())
  } catch (error) {
    return { status: "error", error }
  }
}

export async function acquireMutationLock(reminderID: string, ctx: PluginInput): Promise<ExecutionLease> {
  const dir = await getStorageDir(ctx)
  const lockPath = path.join(dir, `${reminderID}.mutation.lock`)
  const owner = await newOwner()
  const deadline = Date.now() + MUTATION_LOCK_TIMEOUT_MS

  while (Date.now() < deadline) {
    const acquisition = await acquireOwnerLock(lockPath, owner)
    if (acquisition.status === "acquired") return acquisition.lease
    if (acquisition.status === "error") throw acquisition.error

    // Mutations are short and never encompass prompt execution. Waiting makes cancellation
    // serializable with an in-flight transition rather than silently abandoning it.
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(MUTATION_LOCK_RETRY_MS, deadline - Date.now())))
  }
  throw new Error(`Timed out acquiring mutation lock for reminder ${reminderID}`)
}
