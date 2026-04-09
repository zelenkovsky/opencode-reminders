import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import RemindersPlugin from "../index"
import type { PluginInput, ToolContext } from "@opencode-ai/plugin"
import { $ } from "bun"

function createMockToolContext(sessionID: string): ToolContext {
  return {
    sessionID,
    messageID: `msg-${sessionID}`,
    agent: "test-agent",
    directory: "/tmp",
    worktree: "/tmp",
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  }
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
    serverUrl: new URL("http://localhost:3000"),
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
    const plugin = await RemindersPlugin.server(ctx)

    expect(plugin).toBeDefined()
    expect(plugin.tool).toBeDefined()
    expect(plugin.event).toBeDefined()
  })

  test("plugin exposes three tools", async () => {
    const plugin = await RemindersPlugin.server(ctx)

    expect(plugin.tool?.reminderadd).toBeDefined()
    expect(plugin.tool?.reminderlist).toBeDefined()
    expect(plugin.tool?.reminderremove).toBeDefined()
  })

  test("reminderadd tool creates reminder", async () => {
    const plugin = await RemindersPlugin.server(ctx)

    const result = await plugin.tool!.reminderadd.execute(
      {
        interval_seconds: 60,
        type: "one-time" as const,
        action_prompt: "check /workspace/test.txt for changes",
        description: "File change check",
      },
      createMockToolContext("ses-integration-test"),
    )

    expect(result).toContain("Reminder set")
    expect(result).toContain("File change check")
  })

  test("reminderlist tool returns empty for new session", async () => {
    const plugin = await RemindersPlugin.server(ctx)

    const result = await plugin.tool!.reminderlist.execute({}, createMockToolContext("ses-new"))

    expect(result).toContain("No active reminders")
  })

  test("reminderlist tool shows active reminders", async () => {
    const plugin = await RemindersPlugin.server(ctx)

    await plugin.tool!.reminderadd.execute(
      {
        interval_seconds: 120,
        type: "recurring" as const,
        action_prompt: "test action",
        description: "Test recurring reminder",
      },
      createMockToolContext("ses-list-test"),
    )

    const result = await plugin.tool!.reminderlist.execute({}, createMockToolContext("ses-list-test"))

    expect(result).toContain("Active reminders")
    expect(result).toContain("Test recurring reminder")
    expect(result).toContain("recurring")
  })

  test("reminderremove tool cancels reminder", async () => {
    const plugin = await RemindersPlugin.server(ctx)

    await plugin.tool!.reminderadd.execute(
      {
        interval_seconds: 90,
        type: "one-time" as const,
        action_prompt: "test",
        description: "Reminder to remove",
      },
      createMockToolContext("ses-remove-test"),
    )

    const removeResult = await plugin.tool!.reminderremove.execute(
      { description_pattern: "remove" },
      createMockToolContext("ses-remove-test"),
    )

    expect(removeResult).toContain("Reminder cancelled")

    const listResult = await plugin.tool!.reminderlist.execute({}, createMockToolContext("ses-remove-test"))

    expect(listResult).toContain("No active reminders")
  })

  test("reminderadd enforces 30 second minimum interval", async () => {
    const plugin = await RemindersPlugin.server(ctx)

    try {
      await plugin.tool!.reminderadd.execute(
        {
          interval_seconds: 10,
          type: "one-time" as const,
          action_prompt: "test",
          description: "Too short interval",
        },
        createMockToolContext("ses-min-interval"),
      )
      expect.unreachable("Should have thrown error for interval < 30")
    } catch (error: any) {
      expect(error.message).toContain("30")
    }
  })

  test("reminderadd respects max reminders limit", async () => {
    const plugin = await RemindersPlugin.server(ctx)

    for (let i = 0; i < 50; i++) {
      await plugin.tool!.reminderadd.execute(
        {
          interval_seconds: 60,
          type: "one-time" as const,
          action_prompt: `test ${i}`,
          description: `Reminder ${i}`,
        },
        createMockToolContext("ses-max-limit"),
      )
    }

    const result = await plugin.tool!.reminderadd.execute(
      {
        interval_seconds: 60,
        type: "one-time" as const,
        action_prompt: "test overflow",
        description: "Should fail",
      },
      createMockToolContext("ses-max-limit"),
    )

    expect(result).toContain("too many reminders")
    expect(result).toContain("50/50")
  })

  test("reminderremove handles no matches", async () => {
    const plugin = await RemindersPlugin.server(ctx)

    const result = await plugin.tool!.reminderremove.execute(
      { description_pattern: "nonexistent" },
      createMockToolContext("ses-no-match"),
    )

    expect(result).toContain("No matching reminder found")
  })

  test("reminderremove handles multiple matches", async () => {
    const plugin = await RemindersPlugin.server(ctx)

    await plugin.tool!.reminderadd.execute(
      {
        interval_seconds: 60,
        type: "one-time" as const,
        action_prompt: "test 1",
        description: "Check email notification",
      },
      createMockToolContext("ses-multi-match"),
    )

    await plugin.tool!.reminderadd.execute(
      {
        interval_seconds: 60,
        type: "one-time" as const,
        action_prompt: "test 2",
        description: "Check system notification",
      },
      createMockToolContext("ses-multi-match"),
    )

    const result = await plugin.tool!.reminderremove.execute(
      { description_pattern: "notification" },
      createMockToolContext("ses-multi-match"),
    )

    expect(result).toContain("2 reminders cancelled")
    expect(result).toContain("Check email notification")
    expect(result).toContain("Check system notification")
  })

  test("event handler cleans up reminders on session deletion", async () => {
    const plugin = await RemindersPlugin.server(ctx)

    await plugin.tool!.reminderadd.execute(
      {
        interval_seconds: 60,
        type: "one-time" as const,
        action_prompt: "test",
        description: "Session cleanup test",
      },
      createMockToolContext("ses-cleanup"),
    )

    let listBefore = await plugin.tool!.reminderlist.execute({}, createMockToolContext("ses-cleanup"))
    expect(listBefore).toContain("Session cleanup test")

    await plugin.event!({
      event: {
        type: "session.deleted",
        properties: {
          info: { id: "ses-cleanup" } as any,
        },
      } as any,
    })

    let listAfter = await plugin.tool!.reminderlist.execute({}, createMockToolContext("ses-cleanup"))
    expect(listAfter).toContain("No active reminders")
  })
})
