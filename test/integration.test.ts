import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import RemindersPlugin from "../index"
import { listReminders } from "../storage"
import type { PluginInput } from "@opencode-ai/plugin"
import { $ } from "bun"

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

  test("reminderadd persists the scheduling agent", async () => {
    const plugin = await RemindersPlugin(ctx)

    await plugin.tool!.reminderadd.execute(
      {
        interval_seconds: 60,
        type: "one-time" as const,
        action_prompt: "check /workspace/test.txt for changes",
        description: "Agent preservation test",
      },
      { sessionID: "ses-agent-test", agent: "God" } as any,
    )

    const [reminder] = await listReminders(ctx)
    expect(reminder.agent).toBe("God")
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
