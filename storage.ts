import path from "path"
import { open, readFile, rename, rm } from "node:fs/promises"
import type { PluginInput } from "@opencode-ai/plugin"
import type { Reminder } from "./types"
import { logger } from "./logger"

export async function getStorageDir(ctx: PluginInput): Promise<string> {
  const dir = path.join(ctx.directory, ".opencode", "reminders", ctx.project.id)
  await ctx.$`mkdir -p ${dir}`.quiet()
  await Bun.write(path.join(ctx.directory, ".opencode", "reminders", ".gitignore"), "*")
  return dir
}

export async function saveReminder(reminder: Reminder, ctx: PluginInput): Promise<void> {
  const dir = await getStorageDir(ctx)
  const filePath = path.join(dir, `${reminder.id}.json`)
  const temporaryPath = path.join(dir, `.${reminder.id}.${crypto.randomUUID()}.tmp`)
  let handle

  try {
    handle = await open(temporaryPath, "wx", 0o600)
    await handle.writeFile(JSON.stringify(reminder, null, 2))
    await handle.close()
    handle = undefined
    await rename(temporaryPath, filePath)
  } finally {
    await handle?.close()
    await rm(temporaryPath, { force: true })
  }
}

export async function loadReminder(id: string, ctx: PluginInput): Promise<Reminder | null> {
  const dir = await getStorageDir(ctx)
  const filePath = path.join(dir, `${id}.json`)

  try {
    return JSON.parse(await readFile(filePath, "utf8")) as Reminder
  } catch (error: any) {
    if (error?.code === "ENOENT") return null
    throw error
  }
}

export async function deleteReminder(id: string, ctx: PluginInput): Promise<void> {
  const dir = await getStorageDir(ctx)
  const filePath = path.join(dir, `${id}.json`)
  await rm(filePath, { force: true })
}

export async function listReminders(ctx: PluginInput): Promise<Reminder[]> {
  const dir = await getStorageDir(ctx)
  const reminders: Reminder[] = []

  for await (const file of new Bun.Glob("*.json").scan({ cwd: dir, absolute: true })) {
    try {
      const reminder = await Bun.file(file).json()
      reminders.push(reminder)
    } catch (error) {
      logger.error(`Failed to load reminder from ${file}:`, error)
    }
  }

  return reminders
}
