import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { $ } from "bun"
import path from "node:path"
import type { PluginInput } from "@opencode-ai/plugin"
import { acquireExecutionLease } from "../leases"
import { getStorageDir, saveReminder } from "../storage"
import type { Reminder } from "../types"

async function context(directory: string): Promise<PluginInput> {
  return {
    client: {} as any,
    project: { id: "lease-project", worktree: directory, time: { created: Date.now() } },
    directory,
    worktree: directory,
    $,
  }
}

async function firstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let output = ""
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return output.trim()
      output += decoder.decode(value, { stream: true })
      const newline = output.indexOf("\n")
      if (newline >= 0) return output.slice(0, newline)
    }
  } finally {
    reader.releaseLock()
  }
}

async function within<T>(promise: Promise<T>, label: string, timeout = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeout) }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function stopChildren(children: Bun.Subprocess[]): Promise<void> {
  for (const child of children) {
    try { (child.stdin as any)?.end() } catch {}
    try { child.kill() } catch {}
  }
  await within(Promise.all(children.map((child) => child.exited)), "child process cleanup", 1000).catch(() => {})
}

describe("execution leases", () => {
  let directory: string
  let ctx: PluginInput

  beforeEach(async () => {
    directory = (await $`mktemp -d`.text()).trim()
    ctx = await context(directory)
  })
  afterEach(async () => { await $`rm -rf ${directory}`.quiet() })

  test("concurrent acquisition has exactly one winner", async () => {
    const attempts = await Promise.all(Array.from({ length: 20 }, () => acquireExecutionLease("rem-lease", 123, ctx)))
    const winners = attempts.filter((lease) => lease.status === "acquired")
    expect(winners).toHaveLength(1)
    if (winners[0]?.status === "acquired") await winners[0].lease.release()
  })

  test("independent child processes have exactly one winner", async () => {
    const fixture = path.join(import.meta.dir, "fixtures", "lease-child.ts")
    const children = Array.from({ length: 2 }, () => Bun.spawn({
      cmd: [process.execPath, fixture, directory, "rem-child", "234"],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    }))
    try {
      const results = await within(Promise.all(children.map((child) => firstLine(child.stdout))), "child ownership result")
      expect(results.filter((result) => result === "winner")).toHaveLength(1)
      expect(results.filter((result) => result === "loser")).toHaveLength(1)
      children[results.indexOf("winner")]!.stdin.end()
      await within(Promise.all(children.map((child) => child.exited)), "child process exit")
    } finally {
      await stopChildren(children)
    }
  })

  test("independent schedulers submit one prompt for a persisted occurrence", async () => {
    const reminder: Reminder = {
      id: "rem-multiprocess-scheduler",
      sessionID: "ses-child",
      projectID: "lease-project",
      type: "one-time",
      interval: 1000,
      originalPrompt: "child prompt",
      userDescription: "child scheduler",
      time: { created: Date.now(), nextExecution: Date.now() + 1000 },
      status: "active",
    }
    await saveReminder(reminder, ctx)
    const dir = await getStorageDir(ctx)
    const reminderPath = `${dir}/${reminder.id}.json`
    const recorder = `${directory}/prompts.txt`
    const fixture = path.join(import.meta.dir, "fixtures", "scheduler-child.ts")
    const children = Array.from({ length: 2 }, () => Bun.spawn({
      cmd: [process.execPath, fixture, directory, reminderPath, recorder],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    }))
    try {
      const results = await within(Promise.all(children.map((child) => firstLine(child.stdout))), "scheduler child result")
      expect(results.filter((result) => result === "prompted")).toHaveLength(1)
      expect(results.filter((result) => result === "finished")).toHaveLength(1)
      expect((await Bun.file(recorder).text()).trim().split("\n")).toHaveLength(1)
      children[results.indexOf("prompted")]!.stdin.end()
      await within(Promise.all(children.map((child) => child.exited)), "scheduler child exit")
    } finally {
      await stopChildren(children)
    }
  })

  test("recovers a lease whose PID start identity was reused", async () => {
    const dir = await getStorageDir(ctx)
    await Bun.write(`${dir}/rem-dead.456.lease`, `pid=${process.pid}\nmarker=dead\nstart=not-this-process\ntoken=dead\n`)

    const lease = await acquireExecutionLease("rem-dead", 456, ctx)
    expect(lease.status).toBe("acquired")
    if (lease.status === "acquired") await lease.lease.release()
  })

  test("does not steal a lease held by this live process", async () => {
    const first = await acquireExecutionLease("rem-live", 789, ctx)
    const second = await acquireExecutionLease("rem-live", 789, ctx)
    expect(first.status).toBe("acquired")
    expect(second.status).toBe("contended")
    if (first.status === "acquired") await first.lease.release()
  })

  test("does not steal an unreadable partial lease", async () => {
    const dir = await getStorageDir(ctx)
    await Bun.write(`${dir}/rem-partial.321.lease`, "pid=")

    expect((await acquireExecutionLease("rem-partial", 321, ctx)).status).toBe("contended")
  })

  test("ignores an abandoned unpublished candidate", async () => {
    const dir = await getStorageDir(ctx)
    await Bun.write(`${dir}/rem-candidate.654.lease.abandoned.candidate`, "partial")

    const lease = await acquireExecutionLease("rem-candidate", 654, ctx)
    expect(lease.status).toBe("acquired")
    if (lease.status === "acquired") await lease.lease.release()
  })

  test("does not reclaim a stale recovery guard", async () => {
    const dir = await getStorageDir(ctx)
    const owner = `pid=${process.pid}\nmarker=dead\nstart=not-this-process\ntoken=dead\n`
    await Bun.write(`${dir}/rem-guard.987.lease`, owner)
    await Bun.write(`${dir}/rem-guard.987.lease.recover`, owner)

    const lease = await acquireExecutionLease("rem-guard", 987, ctx)
    expect(lease.status).toBe("contended")
  })
})
