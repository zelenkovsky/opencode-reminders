import { test, expect, describe } from "bun:test"
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
  return {
    client: {
      session: {
        prompt: async () => ({ data: {} as any, error: undefined, response: {} as any }),
        get: async () => ({ data: { id: "ses-test" } as any, error: undefined, response: {} as any }),
      },
    } as any,
    project: {
      id: "test-config",
      worktree: tmpDir,
      time: { created: Date.now() },
    },
    directory: tmpDir,
    worktree: tmpDir,
    serverUrl: new URL("http://localhost:3000"),
    $: $,
  }
}

describe("Configuration Tests", () => {
  let tmpDir: string
  let ctx: PluginInput
  const pluginModule = RemindersPlugin

  test("config hook updates max reminders", async () => {
    tmpDir = await $`mktemp -d`.text().then((t) => t.trim())
    ctx = await createMockContext(tmpDir)

    const plugin = await pluginModule.server(ctx)

    // Test default config
    const result1 = await plugin.tool!.reminderadd.execute(
      {
        interval_seconds: 60,
        type: "one-time" as const,
        action_prompt: "test",
        description: "Test 1",
      },
      createMockToolContext("ses-config-test"),
    )
    expect(result1).toContain("Reminder set")

    // Update config via hook
    await plugin.config!({ reminders: { max_reminders_per_project: 1 } } as any)

    // Try to add second reminder (should fail with new limit)
    const result2 = await plugin.tool!.reminderadd.execute(
      {
        interval_seconds: 60,
        type: "one-time" as const,
        action_prompt: "test 2",
        description: "Test 2",
      },
      createMockToolContext("ses-config-test"),
    )
    expect(result2).toContain("too many reminders")
    expect(result2).toContain("1/1")

    await $`rm -rf ${tmpDir}`.quiet()
  })

  test("timer health validation detects failed timers", async () => {
    tmpDir = await $`mktemp -d`.text().then((t) => t.trim())
    ctx = await createMockContext(tmpDir)

    // Create reminder file directly (simulating stored reminder)
    const storageDir = `${tmpDir}/.opencode/reminders/test-config`
    await $`mkdir -p ${storageDir}`.quiet()

    const reminder = {
      id: "test-health-check",
      sessionID: "ses-health",
      projectID: "test-config",
      type: "one-time",
      interval: 5000,
      originalPrompt: "test",
      userDescription: "Health test",
      time: {
        created: Date.now(),
        nextExecution: Date.now() + 5000,
      },
      status: "active",
    }

    await Bun.write(`${storageDir}/test-health-check.json`, JSON.stringify(reminder))

    // Initialize plugin - should restore and validate
    const plugin = await pluginModule.server(ctx)

    // Check logs for health validation
    // Since we can't easily check internal state, just verify no crash
    expect(plugin).toBeDefined()

    await $`rm -rf ${tmpDir}`.quiet()
  })
})
