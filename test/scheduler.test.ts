import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import { scheduleTimer, executeReminder, cancelReminder } from "../scheduler"
import type { Reminder, State, PluginConfig } from "../types"
import type { PluginInput } from "@opencode-ai/plugin"
import { $ } from "bun"

async function createMockContext(tmpDir: string): Promise<PluginInput> {
  return {
    client: {
      session: {
        prompt: async () => ({ data: {} as any, error: undefined, response: {} as any }),
        get: async () => ({ data: { id: "ses-test" } as any, error: undefined, response: {} as any }),
      },
      tui: {
        showToast: async () => {}
      }
    } as any,
    project: {
      id: "test-project-123",
      worktree: tmpDir,
      time: { created: Date.now() },
    },
    directory: tmpDir,
    worktree: tmpDir,
    $: $,
  }
}

function createMockConfig(): PluginConfig {
  return {
    enabled: true,
    max_reminders_per_project: 10,
    min_interval_seconds: 30,
    notifications: {
      enabled: true
    }
  }
}

describe("Scheduler", () => {
  let tmpDir: string
  let ctx: PluginInput
  let state: State
  let config: PluginConfig

  beforeEach(async () => {
    tmpDir = await $`mktemp -d`.text().then((t) => t.trim())
    ctx = await createMockContext(tmpDir)
    state = {
      reminders: new Map(),
      timers: new Map(),
      projectID: "test-project-123",
    }
    config = createMockConfig()
  })

  afterEach(async () => {
    for (const timer of state.timers.values()) {
      clearTimeout(timer)
    }
    await $`rm -rf ${tmpDir}`.quiet()
  })

  test("scheduleTimer creates timer", async () => {
    const reminder: Reminder = {
      id: "rem-timer-test",
      sessionID: "ses-test",
      projectID: "test-project-123",
      type: "one-time",
      interval: 5000,
      originalPrompt: "test",
      userDescription: "Timer test",
      time: {
        created: Date.now(),
        nextExecution: Date.now() + 5000,
      },
      status: "active",
    }

    state.reminders.set(reminder.id, reminder)
    await scheduleTimer(reminder, ctx, state, config)

    expect(state.timers.has(reminder.id)).toBe(true)
  })

  test("scheduleTimer replaces existing timer", async () => {
    const reminder: Reminder = {
      id: "rem-replace-test",
      sessionID: "ses-test",
      projectID: "test-project-123",
      type: "recurring",
      interval: 10000,
      originalPrompt: "test",
      userDescription: "Replace test",
      time: {
        created: Date.now(),
        nextExecution: Date.now() + 10000,
      },
      status: "active",
    }

    state.reminders.set(reminder.id, reminder)
    await scheduleTimer(reminder, ctx, state, config)

    const firstTimer = state.timers.get(reminder.id)
    expect(firstTimer).toBeDefined()

    reminder.time.nextExecution = Date.now() + 20000
    await scheduleTimer(reminder, ctx, state, config)

    const secondTimer = state.timers.get(reminder.id)
    expect(secondTimer).toBeDefined()
    expect(secondTimer).not.toBe(firstTimer)
  })

  test("cancelReminder clears timer and removes from state", async () => {
    const reminder: Reminder = {
      id: "rem-cancel-test",
      sessionID: "ses-test",
      projectID: "test-project-123",
      type: "one-time",
      interval: 5000,
      originalPrompt: "test",
      userDescription: "Cancel test",
      time: {
        created: Date.now(),
        nextExecution: Date.now() + 5000,
      },
      status: "active",
    }

    state.reminders.set(reminder.id, reminder)
    await scheduleTimer(reminder, ctx, state, config)

    expect(state.timers.has(reminder.id)).toBe(true)
    expect(state.reminders.has(reminder.id)).toBe(true)

    await cancelReminder(reminder.id, ctx, state)

    expect(state.timers.has(reminder.id)).toBe(false)
    expect(state.reminders.has(reminder.id)).toBe(false)
  })

  test("cancelReminder handles non-existent reminder gracefully", async () => {
    await cancelReminder("non-existent", ctx, state)

    expect(state.timers.size).toBe(0)
    expect(state.reminders.size).toBe(0)
  })

  test("executeReminder calls session prompt", async () => {
    let promptCalled = false
    let capturedPrompt = ""

    ;(ctx.client.session.prompt as any) = async (opts: any) => {
      promptCalled = true
      capturedPrompt = opts.body?.parts?.[0]?.text || ""
      return { data: {} as any, error: undefined, response: {} as any }
    }

    const reminder: Reminder = {
      id: "rem-execute-test",
      sessionID: "ses-test",
      projectID: "test-project-123",
      type: "one-time",
      interval: 100,
      originalPrompt: "test prompt text",
      userDescription: "Execute test",
      time: {
        created: Date.now(),
        nextExecution: Date.now() + 100,
      },
      status: "active",
    }

    state.reminders.set(reminder.id, reminder)
    await executeReminder(reminder, ctx, state, config)

    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(promptCalled).toBe(true)
    expect(capturedPrompt).toBe("test prompt text")
  })

  test("executeReminder updates lastExecution time", async () => {
    const reminder: Reminder = {
      id: "rem-last-exec-test",
      sessionID: "ses-test",
      projectID: "test-project-123",
      type: "one-time",
      interval: 100,
      originalPrompt: "test",
      userDescription: "Last exec test",
      time: {
        created: Date.now(),
        nextExecution: Date.now() + 100,
      },
      status: "active",
    }

    state.reminders.set(reminder.id, reminder)
    const before = Date.now()
    await executeReminder(reminder, ctx, state, config)
    const after = Date.now()

    expect(reminder.time.lastExecution).toBeGreaterThanOrEqual(before)
    expect(reminder.time.lastExecution).toBeLessThanOrEqual(after)
  })

  test("executeReminder cancels one-time reminder after execution", async () => {
    const reminder: Reminder = {
      id: "rem-onetime-cancel",
      sessionID: "ses-test",
      projectID: "test-project-123",
      type: "one-time",
      interval: 100,
      originalPrompt: "test",
      userDescription: "One-time cancel test",
      time: {
        created: Date.now(),
        nextExecution: Date.now() + 100,
      },
      status: "active",
    }

    state.reminders.set(reminder.id, reminder)
    await executeReminder(reminder, ctx, state, config)

    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(state.reminders.has(reminder.id)).toBe(false)
  })

  test("executeReminder reschedules recurring reminder", async () => {
    const reminder: Reminder = {
      id: "rem-recurring-reschedule",
      sessionID: "ses-test",
      projectID: "test-project-123",
      type: "recurring",
      interval: 1000,
      originalPrompt: "test",
      userDescription: "Recurring reschedule test",
      time: {
        created: Date.now(),
        nextExecution: Date.now() + 1000,
      },
      status: "active",
    }

    const oldNextExecution = reminder.time.nextExecution
    state.reminders.set(reminder.id, reminder)
    await executeReminder(reminder, ctx, state, config)

    await new Promise((resolve) => setTimeout(resolve, 50))

    const updatedReminder = state.reminders.get(reminder.id)
    expect(updatedReminder).toBeDefined()
    expect(updatedReminder!.time.nextExecution).toBeGreaterThanOrEqual(oldNextExecution)
    expect(state.timers.has(reminder.id)).toBe(true)
  })

  test("scheduleTimer maintains cadence for missed recurring reminders", async () => {
    const interval = 3600000 // 1 hour
    const originalScheduledTime = Date.now() - 5400000 // 1.5 hours ago
    
    const reminder: Reminder = {
      id: "rem-missed-cadence",
      sessionID: "ses-test",
      projectID: "test-project-123",
      type: "recurring",
      interval,
      originalPrompt: "test",
      userDescription: "Missed cadence test",
      time: {
        created: Date.now() - 7200000, // 2 hours ago
        nextExecution: originalScheduledTime,
      },
      status: "active",
    }

    state.reminders.set(reminder.id, reminder)
    await scheduleTimer(reminder, ctx, state, config)

    // Should schedule for next interval from the original time, not from now
    // Original: now - 1.5h, interval: 1h, missed: 2 intervals
    // Next should be: (now - 1.5h) + (2 * 1h) = now + 0.5h
    const expectedNext = originalScheduledTime + (2 * interval)
    const actualNext = reminder.time.nextExecution
    
    // Allow 100ms tolerance for test execution time
    expect(Math.abs(actualNext - expectedNext)).toBeLessThan(100)
    
    // Verify the delay is approximately 30 minutes (half an hour from now)
    const now = Date.now()
    const delay = actualNext - now
    expect(delay).toBeGreaterThan(1700000) // ~28 minutes
    expect(delay).toBeLessThan(1900000) // ~32 minutes
  })
})
