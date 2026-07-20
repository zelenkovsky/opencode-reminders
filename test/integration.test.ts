import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import RemindersPlugin from "../index"
import type { PluginInput } from "@opencode-ai/plugin"
import { $ } from "bun"

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
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

  test("replacement initialization drains an in-flight reminder save before restoring", async () => {
    const plugin = await RemindersPlugin(ctx)
    const writeStarted = deferred()
    const allowWrite = deferred()
    const originalWrite = Bun.write
    let intercepted = false

    ;(Bun as any).write = async (destination: unknown, input: unknown, options?: unknown) => {
      if (!intercepted && typeof destination === "string" && destination.endsWith(".json")) {
        intercepted = true
        writeStarted.resolve()
        await allowWrite.promise
      }
      return (originalWrite as any)(destination, input, options)
    }

    try {
      const addPromise = plugin.tool!.reminderadd.execute(
        {
          interval_seconds: 60,
          type: "one-time" as const,
          action_prompt: "test generation handoff",
          description: "Generation handoff reminder",
        },
        { sessionID: "ses-generation-handoff" } as any,
      )
      await writeStarted.promise

      let replacementResolved = false
      const replacementPromise = RemindersPlugin(ctx).then((replacement) => {
        replacementResolved = true
        return replacement
      })
      await Bun.sleep(10)
      expect(replacementResolved).toBe(false)

      allowWrite.resolve()
      const [addResult, replacement] = await Promise.all([addPromise, replacementPromise])
      expect(addResult).toContain("scheduler reloaded")

      const listResult = await replacement.tool!.reminderlist.execute(
        {},
        { sessionID: "ses-generation-handoff" } as any,
      )
      expect(listResult).toContain("Generation handoff reminder")

      await replacement.tool!.reminderremove.execute(
        { description_pattern: "Generation handoff" },
        { sessionID: "ses-generation-handoff" } as any,
      )
    } finally {
      allowWrite.resolve()
      ;(Bun as any).write = originalWrite
    }
  })

  test("a stale reminderremove tool cancels the replacement generation reminder", async () => {
    const stalePlugin = await RemindersPlugin(ctx)
    await stalePlugin.tool!.reminderadd.execute(
      {
        interval_seconds: 60,
        type: "recurring" as const,
        action_prompt: "test stale cancellation",
        description: "Stale generation cancellation",
      },
      { sessionID: "ses-stale-cancellation" } as any,
    )

    const replacement = await RemindersPlugin(ctx)
    const removeResult = await stalePlugin.tool!.reminderremove.execute(
      { description_pattern: "Stale generation" },
      { sessionID: "ses-stale-cancellation" } as any,
    )
    expect(removeResult).toContain("Reminder cancelled")

    const listResult = await replacement.tool!.reminderlist.execute(
      {},
      { sessionID: "ses-stale-cancellation" } as any,
    )
    expect(listResult).toContain("No active reminders")
  })

  test("startup preserves a stored reminder when advancing its missed schedule cannot be persisted", async () => {
    const plugin = await RemindersPlugin(ctx)
    await plugin.tool!.reminderadd.execute(
      {
        interval_seconds: 60,
        type: "recurring" as const,
        action_prompt: "test startup persistence failure",
        description: "Startup persistence failure",
      },
      { sessionID: "ses-startup-persistence" } as any,
    )

    const storageDir = `${tmpDir}/.opencode/reminders/test-project-integration`
    const files: string[] = []
    for await (const file of new Bun.Glob("*.json").scan({ cwd: storageDir, absolute: true })) {
      files.push(file)
    }
    expect(files).toHaveLength(1)
    const stored = await Bun.file(files[0]).json()
    stored.time.nextExecution = Date.now() - 1000
    await Bun.write(files[0], JSON.stringify(stored, null, 2))

    const originalWrite = Bun.write
    ;(Bun as any).write = async (destination: unknown, input: unknown, options?: unknown) => {
      if (typeof destination === "string" && destination.endsWith(".json")) {
        throw new Error("simulated reminder write failure")
      }
      return (originalWrite as any)(destination, input, options)
    }

    try {
      const replacement = await RemindersPlugin(ctx)
      const listResult = await replacement.tool!.reminderlist.execute(
        {},
        { sessionID: "ses-startup-persistence" } as any,
      )
      expect(listResult).toContain("No active reminders")
    } finally {
      ;(Bun as any).write = originalWrite
    }

    expect(await Bun.file(files[0]).exists()).toBe(true)
    expect((await Bun.file(files[0]).json()).id).toBe(stored.id)
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
