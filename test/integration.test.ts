import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test"
import * as fsPromises from "node:fs/promises"
import RemindersPlugin from "../index"
import type { PluginInput } from "@opencode-ai/plugin"
import { $ } from "bun"
import { acquireMutationLock } from "../leases"
import { cancelReminder, executeReminder } from "../scheduler"
import { getStorageDir, loadReminder, saveReminder } from "../storage"
import type { PluginConfig, Reminder, State } from "../types"

async function waitFor(predicate: () => boolean | Promise<boolean>, timeout = 4000): Promise<void> {
  const deadline = Date.now() + timeout
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition")
    await Bun.sleep(25)
  }
}

function failReminderRenames() {
  const rename = fsPromises.rename
  return spyOn(fsPromises, "rename").mockImplementation((async (source: any, destination: any) => {
    if (String(destination).endsWith(".json")) {
      throw Object.assign(new Error("simulated atomic rename failure"), { code: "EIO" })
    }
    return rename(source, destination)
  }) as any)
}

async function createMockContext(tmpDir: string): Promise<PluginInput> {
  const sessions = new Map<string, any>()

  return {
    client: {
      session: {
        prompt: async () => ({ data: {} as any, error: undefined, response: {} as any }),
        get: async (opts: any) => {
          const session = sessions.get(opts.path.id)
          if (!session) throw new Error("Session not found")
          return { data: session, error: undefined, response: {} as any }
        },
        list: async () => ({ data: Array.from(sessions.values()), error: undefined, response: {} as any }),
      },
      event: {
        subscribe: async () => ({
          async *[Symbol.asyncIterator]() {},
        }),
      },
    } as any,
    project: {
      id: "test-project-integration",
      worktree: tmpDir,
      time: { created: Date.now() },
    },
    directory: tmpDir,
    worktree: tmpDir,
    $: $,
  }
}

describe("Integration Tests", () => {
  let tmpDir: string
  let ctx: PluginInput

  beforeEach(async () => {
    tmpDir = await $`mktemp -d`.text().then((t) => t.trim())
    ctx = await createMockContext(tmpDir)
  })

  afterEach(async () => {
    await $`rm -rf ${tmpDir}`.quiet()
  })

  test("plugin initializes successfully", async () => {
    const plugin = await RemindersPlugin(ctx)

    expect(plugin).toBeDefined()
    expect(plugin.tool).toBeDefined()
    expect(plugin.event).toBeDefined()
  })

  test("plugin exposes three tools", async () => {
    const plugin = await RemindersPlugin(ctx)

    expect(plugin.tool?.reminderadd).toBeDefined()
    expect(plugin.tool?.reminderlist).toBeDefined()
    expect(plugin.tool?.reminderremove).toBeDefined()
  })

  test("reminderadd tool creates reminder", async () => {
    const plugin = await RemindersPlugin(ctx)

    const result = await plugin.tool!.reminderadd.execute(
      {
        interval_seconds: 60,
        type: "one-time" as const,
        action_prompt: "check /workspace/test.txt for changes",
        description: "File change check",
      },
      { sessionID: "ses-integration-test" } as any,
    )

    expect(result).toContain("Reminder set")
    expect(result).toContain("File change check")
  })

  test("reminderadd captures the creating agent", async () => {
    const plugin = await RemindersPlugin(ctx)
    await plugin.tool!.reminderadd.execute(
      {
        interval_seconds: 60,
        type: "one-time" as const,
        action_prompt: "agent action",
        description: "Agent capture",
      },
      { sessionID: "ses-agent", agent: "build" } as any,
    )

    const directory = `${tmpDir}/.opencode/reminders/test-project-integration`
    const files = await Array.fromAsync(new Bun.Glob("*.json").scan({ cwd: directory, absolute: true }))
    expect(files).toHaveLength(1)
    expect((await Bun.file(files[0]).json()).agent).toBe("build")
  })

  test("replacement initialization drains and fences an in-progress add", async () => {
    const plugin = await RemindersPlugin(ctx)
    const lock = await acquireMutationLock("blocked", ctx)
    const originalUUID = crypto.randomUUID
    ;(crypto as any).randomUUID = () => "blocked"
    try {
      const add = plugin.tool!.reminderadd.execute(
        {
          interval_seconds: 60,
          type: "one-time" as const,
          action_prompt: "blocked add",
          description: "Blocked add",
        },
        { sessionID: "ses-blocked" } as any,
      )
      await Bun.sleep(50)
      const replacement = RemindersPlugin(ctx)
      await Bun.sleep(50)
      await lock.release()

      expect(await add).toContain("scheduler reloaded")
      const replacementPlugin = await replacement
      expect(await replacementPlugin.tool!.reminderlist.execute(
        {},
        { sessionID: "ses-blocked" } as any,
      )).toContain("No active reminders")
    } finally {
      ;(crypto as any).randomUUID = originalUUID
      await lock.release()
    }
  })

  test("a stale remove tool cancels the replacement generation reminder", async () => {
    const stale = await RemindersPlugin(ctx)
    await stale.tool!.reminderadd.execute(
      {
        interval_seconds: 60,
        type: "recurring" as const,
        action_prompt: "stale cancellation",
        description: "Stale generation cancellation",
      },
      { sessionID: "ses-stale" } as any,
    )
    const replacement = await RemindersPlugin(ctx)

    expect(await stale.tool!.reminderremove.execute(
      { description_pattern: "Stale generation" },
      { sessionID: "ses-stale" } as any,
    )).toContain("Reminder cancelled")
    expect(await replacement.tool!.reminderlist.execute(
      {},
      { sessionID: "ses-stale" } as any,
    )).toContain("No active reminders")
  })

  test("startup preserves a stored reminder when advancing its missed schedule cannot be persisted", async () => {
    const plugin = await RemindersPlugin(ctx)
    await plugin.tool!.reminderadd.execute(
      {
        interval_seconds: 60,
        type: "recurring" as const,
        action_prompt: "must not execute a missed startup occurrence",
        description: "Startup persistence failure",
      },
      { sessionID: "ses-startup-persistence" } as any,
    )
    const directory = await getStorageDir(ctx)
    const files = await Array.fromAsync(new Bun.Glob("*.json").scan({ cwd: directory, absolute: true }))
    const stored = await Bun.file(files[0]).json()
    stored.time.nextExecution = Date.now() - 1000
    await Bun.write(files[0], JSON.stringify(stored, null, 2))

    let prompts = 0
    ;(ctx.client.session.prompt as any) = async () => {
      prompts++
      return { data: {}, error: undefined, response: {} }
    }
    const rename = failReminderRenames()
    let replacement: Awaited<ReturnType<typeof RemindersPlugin>> | undefined
    try {
      replacement = await RemindersPlugin(ctx)
      await Bun.sleep(850)

      expect(prompts).toBe(0)
      expect((await Bun.file(files[0]).json()).time.nextExecution).toBe(stored.time.nextExecution)
      expect(rename.mock.calls.length).toBeGreaterThanOrEqual(2)
      expect(rename.mock.calls.length).toBeLessThanOrEqual(4)
    } finally {
      rename.mockRestore()
    }

    await waitFor(async () => (await Bun.file(files[0]).json()).time.nextExecution > Date.now())
    expect(prompts).toBe(0)
    expect(await replacement!.tool!.reminderremove.execute(
      { description_pattern: "Startup persistence failure" },
      { sessionID: "ses-startup-persistence" } as any,
    )).toContain("Reminder cancelled")
  })

  test("runtime transition failures retry with backoff and retain the future occurrence", async () => {
    const reminder: Reminder = {
      id: "rem-runtime-backoff",
      sessionID: "ses-runtime-backoff",
      projectID: ctx.project.id,
      type: "recurring",
      interval: 60000,
      originalPrompt: "runtime retry",
      userDescription: "Runtime retry",
      time: { created: Date.now(), nextExecution: Date.now() - 1 },
      status: "active",
    }
    const state: State = {
      reminders: new Map([[reminder.id, reminder]]),
      timers: new Map(),
      projectID: ctx.project.id,
    }
    const config: PluginConfig = {
      enabled: true,
      max_reminders_per_project: 50,
      min_interval_seconds: 30,
      notifications: { enabled: false },
    }
    await saveReminder(reminder, ctx)
    let prompts = 0
    ;(ctx.client.session.prompt as any) = async () => {
      prompts++
      return { data: {}, error: undefined, response: {} }
    }

    const rename = failReminderRenames()
    try {
      await executeReminder(reminder, ctx, state, config)
      await Bun.sleep(850)
      expect(prompts).toBeGreaterThanOrEqual(2)
      expect(prompts).toBeLessThanOrEqual(3)
      expect((await loadReminder(reminder.id, ctx))!.time.nextExecution).toBe(reminder.time.nextExecution)
    } finally {
      rename.mockRestore()
    }

    await waitFor(async () => (await loadReminder(reminder.id, ctx))!.time.nextExecution > Date.now())
    expect(prompts).toBeLessThanOrEqual(4)
    expect(state.timers.has(reminder.id)).toBe(true)
    await cancelReminder(reminder.id, ctx, state)
  })

  test("reminderlist tool returns empty for new session", async () => {
    const plugin = await RemindersPlugin(ctx)

    const result = await plugin.tool!.reminderlist.execute({}, { sessionID: "ses-new" } as any)

    expect(result).toContain("No active reminders")
  })

  test("reminderlist tool shows active reminders", async () => {
    const plugin = await RemindersPlugin(ctx)

    await plugin.tool!.reminderadd.execute(
      {
        interval_seconds: 120,
        type: "recurring" as const,
        action_prompt: "test action",
        description: "Test recurring reminder",
      },
      { sessionID: "ses-list-test" } as any,
    )

    const result = await plugin.tool!.reminderlist.execute({}, { sessionID: "ses-list-test" } as any)

    expect(result).toContain("Active reminders")
    expect(result).toContain("Test recurring reminder")
    expect(result).toContain("recurring")
  })

  test("reminderremove tool cancels reminder", async () => {
    const plugin = await RemindersPlugin(ctx)

    await plugin.tool!.reminderadd.execute(
      {
        interval_seconds: 90,
        type: "one-time" as const,
        action_prompt: "test",
        description: "Reminder to remove",
      },
      { sessionID: "ses-remove-test" } as any,
    )

    const removeResult = await plugin.tool!.reminderremove.execute(
      { description_pattern: "remove" },
      { sessionID: "ses-remove-test" } as any,
    )

    expect(removeResult).toContain("Reminder cancelled")

    const listResult = await plugin.tool!.reminderlist.execute({}, { sessionID: "ses-remove-test" } as any)

    expect(listResult).toContain("No active reminders")
  })

  test("reminderadd enforces 30 second minimum interval", async () => {
    const plugin = await RemindersPlugin(ctx)

    try {
      await plugin.tool!.reminderadd.execute(
        {
          interval_seconds: 10,
          type: "one-time" as const,
          action_prompt: "test",
          description: "Too short interval",
        },
        { sessionID: "ses-min-interval" } as any,
      )
      expect.unreachable("Should have thrown error for interval < 30")
    } catch (error: any) {
      expect(error.message).toContain("30")
    }
  })

  test("reminderadd respects max reminders limit", async () => {
    const plugin = await RemindersPlugin(ctx)

    for (let i = 0; i < 50; i++) {
      await plugin.tool!.reminderadd.execute(
        {
          interval_seconds: 60,
          type: "one-time" as const,
          action_prompt: `test ${i}`,
          description: `Reminder ${i}`,
        },
        { sessionID: "ses-max-limit" } as any,
      )
    }

    const result = await plugin.tool!.reminderadd.execute(
      {
        interval_seconds: 60,
        type: "one-time" as const,
        action_prompt: "test overflow",
        description: "Should fail",
      },
      { sessionID: "ses-max-limit" } as any,
    )

    expect(result).toContain("too many reminders")
    expect(result).toContain("50/50")
  })

  test("reminderremove handles no matches", async () => {
    const plugin = await RemindersPlugin(ctx)

    const result = await plugin.tool!.reminderremove.execute(
      { description_pattern: "nonexistent" },
      { sessionID: "ses-no-match" } as any,
    )

    expect(result).toContain("No matching reminder found")
  })

  test("reminderremove handles multiple matches", async () => {
    const plugin = await RemindersPlugin(ctx)

    await plugin.tool!.reminderadd.execute(
      {
        interval_seconds: 60,
        type: "one-time" as const,
        action_prompt: "test 1",
        description: "Check email notification",
      },
      { sessionID: "ses-multi-match" } as any,
    )

    await plugin.tool!.reminderadd.execute(
      {
        interval_seconds: 60,
        type: "one-time" as const,
        action_prompt: "test 2",
        description: "Check system notification",
      },
      { sessionID: "ses-multi-match" } as any,
    )

    const result = await plugin.tool!.reminderremove.execute(
      { description_pattern: "notification" },
      { sessionID: "ses-multi-match" } as any,
    )

    expect(result).toContain("2 reminders cancelled")
    expect(result).toContain("Check email notification")
    expect(result).toContain("Check system notification")
  })

  test("event handler cleans up reminders on session deletion", async () => {
    const plugin = await RemindersPlugin(ctx)

    await plugin.tool!.reminderadd.execute(
      {
        interval_seconds: 60,
        type: "one-time" as const,
        action_prompt: "test",
        description: "Session cleanup test",
      },
      { sessionID: "ses-cleanup" } as any,
    )

    let listBefore = await plugin.tool!.reminderlist.execute({}, { sessionID: "ses-cleanup" } as any)
    expect(listBefore).toContain("Session cleanup test")

    await plugin.event!({
      event: {
        type: "session.deleted",
        properties: {
          info: { id: "ses-cleanup" } as any,
        },
      } as any,
    })

    let listAfter = await plugin.tool!.reminderlist.execute({}, { sessionID: "ses-cleanup" } as any)
    expect(listAfter).toContain("No active reminders")
  })
})
