import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test"
import * as fsPromises from "node:fs/promises"
import {
  beginSchedulerGeneration,
  waitForSchedulerMutations,
  scheduleTimer,
  executeReminder,
  cancelReminder,
  reconcileReminder,
  cleanupReminderSnapshot,
} from "../scheduler"
import type { Reminder, State, PluginConfig } from "../types"
import type { PluginInput } from "@opencode-ai/plugin"
import { $ } from "bun"
import { saveReminder, loadReminder, deleteReminder, getStorageDir } from "../storage"
import { acquireExecutionLease, acquireMutationLock } from "../leases"

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeout = 2000): Promise<void> {
  const deadline = Date.now() + timeout
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition")
    await Bun.sleep(10)
  }
}

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
    const generation = beginSchedulerGeneration(ctx)
    await waitForSchedulerMutations(ctx, generation)
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
    await saveReminder(reminder, ctx)
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
    await saveReminder(reminder, ctx)
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
    await saveReminder(reminder, ctx)
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
    await saveReminder(reminder, ctx)
    await executeReminder(reminder, ctx, state, config)

    await new Promise((resolve) => setTimeout(resolve, 50))

    const updatedReminder = state.reminders.get(reminder.id)
    expect(updatedReminder).toBeDefined()
    expect(updatedReminder!.time.nextExecution).toBeGreaterThanOrEqual(oldNextExecution)
    expect(state.timers.has(reminder.id)).toBe(true)
  })

  test("losing execution contender does not prompt or mutate persistence", async () => {
    const reminder: Reminder = {
      id: "rem-cross-process-owner",
      sessionID: "ses-test",
      projectID: "test-project-123",
      type: "one-time",
      interval: 100,
      originalPrompt: "only once",
      userDescription: "Lease ownership test",
      time: { created: Date.now(), nextExecution: Date.now() + 100 },
      status: "active",
    }
    const otherState: State = { reminders: new Map([[reminder.id, { ...reminder, time: { ...reminder.time } }]]), timers: new Map(), projectID: state.projectID }
    let firstPrompted!: () => void
    const promptStarted = new Promise<void>((resolve) => { firstPrompted = resolve })
    let finishPrompt!: () => void
    const promptFinished = new Promise<void>((resolve) => { finishPrompt = resolve })
    let prompts = 0
    ;(ctx.client.session.prompt as any) = async () => {
      prompts++
      firstPrompted()
      await promptFinished
      return { data: {} as any, error: undefined, response: {} as any }
    }

    state.reminders.set(reminder.id, reminder)
    await saveReminder(reminder, ctx)
    const winner = executeReminder(reminder, ctx, state, config)
    await promptStarted
    await executeReminder(otherState.reminders.get(reminder.id)!, ctx, otherState, config)

    expect(prompts).toBe(1)
    expect(await loadReminder(reminder.id, ctx)).toEqual(reminder)
    expect(otherState.reminders.has(reminder.id)).toBe(true)
    finishPrompt()
    await winner
  })

  test("recurring loser reconciles to the winner's future occurrence", async () => {
    const reminder: Reminder = {
      id: "rem-recurring-contended",
      sessionID: "ses-test",
      projectID: "test-project-123",
      type: "recurring",
      interval: 60000,
      originalPrompt: "only once now",
      userDescription: "Recurring lease reconciliation",
      time: { created: Date.now(), nextExecution: Date.now() + 100 },
      status: "active",
    }
    const loserState: State = {
      reminders: new Map([[reminder.id, { ...reminder, time: { ...reminder.time } }]]),
      timers: new Map(),
      projectID: state.projectID,
    }
    let started!: () => void
    const promptStarted = new Promise<void>((resolve) => { started = resolve })
    let finish!: () => void
    const promptFinished = new Promise<void>((resolve) => { finish = resolve })
    ;(ctx.client.session.prompt as any) = async () => {
      started()
      await promptFinished
      return { data: {} as any, error: undefined, response: {} as any }
    }

    state.reminders.set(reminder.id, reminder)
    await saveReminder(reminder, ctx)
    const winner = executeReminder(reminder, ctx, state, config)
    await promptStarted
    await executeReminder(loserState.reminders.get(reminder.id)!, ctx, loserState, config)
    expect(loserState.timers.has(reminder.id)).toBe(true)

    finish()
    await winner
    const persisted = await loadReminder(reminder.id, ctx)
    expect(persisted).not.toBeNull()
    // The loser keeps its unref'd retry; wait only after the winner's completion barrier.
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(loserState.reminders.get(reminder.id)?.time.nextExecution).toBe(persisted!.time.nextExecution)
    expect(loserState.timers.has(reminder.id)).toBe(true)
  })

  test("scheduler recovers a crashed owner's recurring occurrence", async () => {
    const reminder: Reminder = {
      id: "rem-dead-owner",
      sessionID: "ses-test",
      projectID: "test-project-123",
      type: "recurring",
      interval: 60000,
      originalPrompt: "recover",
      userDescription: "Dead owner recovery",
      time: { created: Date.now(), nextExecution: Date.now() + 100 },
      status: "active",
    }
    state.reminders.set(reminder.id, reminder)
    await saveReminder(reminder, ctx)
    const dir = await getStorageDir(ctx)
    await Bun.write(`${dir}/${reminder.id}.${reminder.time.nextExecution}.lease`, `pid=${process.pid}\nmarker=dead\nstart=not-this-process\ntoken=dead\n`)
    let prompts = 0
    ;(ctx.client.session.prompt as any) = async () => {
      prompts++
      return { data: {} as any, error: undefined, response: {} as any }
    }

    await executeReminder(reminder, ctx, state, config)
    expect(prompts).toBe(1)
    expect((await loadReminder(reminder.id, ctx))!.time.nextExecution).toBeGreaterThan(reminder.time.nextExecution)
  })

  test("cancellation before executor mutation cannot be overwritten", async () => {
    const reminder: Reminder = {
      id: "rem-cancel-during-prompt",
      sessionID: "ses-test",
      projectID: "test-project-123",
      type: "recurring",
      interval: 60000,
      originalPrompt: "cancelled",
      userDescription: "Cancellation fence",
      time: { created: Date.now(), nextExecution: Date.now() + 100 },
      status: "active",
    }
    let started!: () => void
    const promptStarted = new Promise<void>((resolve) => { started = resolve })
    let finish!: () => void
    const promptFinished = new Promise<void>((resolve) => { finish = resolve })
    ;(ctx.client.session.prompt as any) = async () => {
      started()
      await promptFinished
      return { data: {} as any, error: undefined, response: {} as any }
    }

    state.reminders.set(reminder.id, reminder)
    await saveReminder(reminder, ctx)
    const execution = executeReminder(reminder, ctx, state, config)
    await promptStarted
    const lock = await acquireMutationLock(reminder.id, ctx)
    const cancellation = cancelReminder(reminder.id, ctx, state)
    await lock.release()
    await cancellation
    finish()
    await execution

    expect(await loadReminder(reminder.id, ctx)).toBeNull()
    expect(state.reminders.has(reminder.id)).toBe(false)
    expect(state.timers.has(reminder.id)).toBe(false)
  })

  test("cancellation after executor mutation deletes the saved recurrence", async () => {
    const reminder: Reminder = {
      id: "rem-cancel-after-mutation",
      sessionID: "ses-test",
      projectID: "test-project-123",
      type: "recurring",
      interval: 60000,
      originalPrompt: "completed",
      userDescription: "Cancellation after mutation",
      time: { created: Date.now(), nextExecution: Date.now() + 100 },
      status: "active",
    }
    state.reminders.set(reminder.id, reminder)
    await saveReminder(reminder, ctx)
    await executeReminder(reminder, ctx, state, config)
    expect(await loadReminder(reminder.id, ctx)).not.toBeNull()

    await cancelReminder(reminder.id, ctx, state)
    expect(await loadReminder(reminder.id, ctx)).toBeNull()
    expect(state.reminders.has(reminder.id)).toBe(false)
    expect(state.timers.has(reminder.id)).toBe(false)
  })

  test("execution owner skips missed recurring reminders with upstream cadence", async () => {
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
    await saveReminder(reminder, ctx)
    let prompts = 0
    ;(ctx.client.session.prompt as any) = async () => {
      prompts++
      return { data: {} as any, error: undefined, response: {} as any }
    }
    await executeReminder(reminder, ctx, state, config, true)

    const expectedNext = originalScheduledTime + (2 * interval)
    expect(Math.abs(state.reminders.get(reminder.id)!.time.nextExecution - expectedNext)).toBeLessThan(100)
    expect(state.timers.has(reminder.id)).toBe(true)
    expect(prompts).toBe(0)
  })

  test("normal late recurring execution prompts instead of skipping", async () => {
    const reminder: Reminder = {
      id: "rem-normal-late",
      sessionID: "ses-test",
      projectID: "test-project-123",
      type: "recurring",
      interval: 60000,
      originalPrompt: "late but normal",
      userDescription: "Normal late execution",
      time: { created: Date.now() - 1000, nextExecution: Date.now() - 1 },
      status: "active",
    }
    let prompts = 0
    ;(ctx.client.session.prompt as any) = async () => {
      prompts++
      return { data: {} as any, error: undefined, response: {} as any }
    }
    state.reminders.set(reminder.id, reminder)
    await saveReminder(reminder, ctx)

    await executeReminder(reminder, ctx, state, config)
    expect(prompts).toBe(1)
    expect((await loadReminder(reminder.id, ctx))!.time.nextExecution).toBeGreaterThan(Date.now())
  })

  test("failover of a contended old occurrence prompts instead of skipping", async () => {
    const reminder: Reminder = {
      id: "rem-failover-old-occurrence",
      sessionID: "ses-test",
      projectID: "test-project-123",
      type: "one-time",
      interval: 1000,
      originalPrompt: "recover old occurrence",
      userDescription: "Old occurrence failover",
      time: { created: Date.now() - 1000, nextExecution: Date.now() - 1 },
      status: "active",
    }
    let prompts = 0
    ;(ctx.client.session.prompt as any) = async () => {
      prompts++
      return { data: {} as any, error: undefined, response: {} as any }
    }
    state.reminders.set(reminder.id, reminder)
    await saveReminder(reminder, ctx)
    const holder = await acquireExecutionLease(reminder.id, reminder.time.nextExecution, ctx)
    expect(holder.status).toBe("acquired")

    await executeReminder(reminder, ctx, state, config)
    if (holder.status === "acquired") await holder.lease.release()
    await new Promise((resolve) => setTimeout(resolve, 500))

    expect(prompts).toBe(1)
    expect(await loadReminder(reminder.id, ctx)).toBeNull()
  })

  test("pre-prompt parse failure preserves state and reconciles after repair", async () => {
    const reminder: Reminder = {
      id: "rem-read-retry",
      sessionID: "ses-test",
      projectID: "test-project-123",
      type: "one-time",
      interval: 1000,
      originalPrompt: "must not prompt while corrupt",
      userDescription: "Read retry",
      time: { created: Date.now(), nextExecution: Date.now() + 1000 },
      status: "active",
    }
    state.reminders.set(reminder.id, reminder)
    await saveReminder(reminder, ctx)
    const dir = await getStorageDir(ctx)
    await Bun.write(`${dir}/${reminder.id}.json`, "{")
    let prompts = 0
    ;(ctx.client.session.prompt as any) = async () => { prompts++; return { data: {} as any, error: undefined, response: {} as any } }

    await executeReminder(reminder, ctx, state, config)
    expect(prompts).toBe(0)
    expect(state.reminders.has(reminder.id)).toBe(true)
    await saveReminder(reminder, ctx)
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(state.timers.has(reminder.id)).toBe(true)
  })

  test("conditional startup cleanup cannot delete a newer occurrence", async () => {
    const snapshot: Reminder = {
      id: "rem-cleanup-snapshot",
      sessionID: "ses-test",
      projectID: "test-project-123",
      type: "recurring",
      interval: 1000,
      originalPrompt: "newer wins",
      userDescription: "Conditional cleanup",
      time: { created: Date.now(), nextExecution: Date.now() - 1000 },
      status: "active",
    }
    const newer = { ...snapshot, time: { ...snapshot.time, nextExecution: Date.now() + 60000 } }
    await saveReminder(newer, ctx)
    expect(await cleanupReminderSnapshot(snapshot, ctx, state, config)).toBe(false)
    expect((await loadReminder(snapshot.id, ctx))!.time.nextExecution).toBe(newer.time.nextExecution)
    expect(state.timers.has(snapshot.id)).toBe(true)
  })

  test("completed reconciliation read cannot resurrect state after cancellation returns", async () => {
    const reminder: Reminder = {
      id: "rem-reconcile-cancel-fence",
      sessionID: "ses-test",
      projectID: state.projectID,
      type: "recurring",
      interval: 60000,
      originalPrompt: "must remain cancelled",
      userDescription: "Reconciliation cancellation fence",
      time: { created: Date.now(), nextExecution: Date.now() + 60000 },
      status: "active",
    }
    state.reminders.set(reminder.id, reminder)
    await saveReminder(reminder, ctx)
    await scheduleTimer(reminder, ctx, state, config, { persist: false })

    const readCompleted = deferred()
    const releaseRead = deferred()
    const readFile = fsPromises.readFile
    let intercepted = false
    const read = spyOn(fsPromises, "readFile").mockImplementation((async (...args: any[]) => {
      const result = await (readFile as any)(...args)
      if (!intercepted && String(args[0]).endsWith(`${reminder.id}.json`)) {
        intercepted = true
        readCompleted.resolve()
        await releaseRead.promise
      }
      return result
    }) as any)

    try {
      const reconciliation = reconcileReminder(reminder.id, ctx, state, config)
      await readCompleted.promise
      await cancelReminder(reminder.id, ctx, state)

      expect(state.reminders.has(reminder.id)).toBe(false)
      expect(state.timers.has(reminder.id)).toBe(false)
      releaseRead.resolve()
      await reconciliation
    } finally {
      releaseRead.resolve()
      read.mockRestore()
    }

    expect(await loadReminder(reminder.id, ctx)).toBeNull()
    expect(state.reminders.has(reminder.id)).toBe(false)
    expect(state.timers.has(reminder.id)).toBe(false)
  })

  test("toast failure after a successful transition does not cancel recurrence", async () => {
    const reminder: Reminder = {
      id: "rem-toast-failure",
      sessionID: "ses-test",
      projectID: "test-project-123",
      type: "recurring",
      interval: 60000,
      originalPrompt: "toast failure",
      userDescription: "Toast failure",
      time: { created: Date.now(), nextExecution: Date.now() + 100 },
      status: "active",
    }
    ;(ctx.client.tui.showToast as any) = async () => { throw new Error("toast unavailable") }
    state.reminders.set(reminder.id, reminder)
    await saveReminder(reminder, ctx)
    await executeReminder(reminder, ctx, state, config)
    expect((await loadReminder(reminder.id, ctx))!.time.nextExecution).toBeGreaterThan(Date.now())
    expect(state.timers.has(reminder.id)).toBe(true)
  })

  test("save failure after prompt acceptance reconciles without cancelling recurrence", async () => {
    const reminder: Reminder = {
      id: "rem-save-failure",
      sessionID: "ses-test",
      projectID: "test-project-123",
      type: "recurring",
      interval: 60000,
      originalPrompt: "accepted before save fails",
      userDescription: "Save failure",
      time: { created: Date.now(), nextExecution: Date.now() + 100 },
      status: "active",
    }
    let started!: () => void
    const promptStarted = new Promise<void>((resolve) => { started = resolve })
    let finish!: () => void
    const promptFinished = new Promise<void>((resolve) => { finish = resolve })
    ;(ctx.client.session.prompt as any) = async () => {
      started()
      await promptFinished
      return { data: {} as any, error: undefined, response: {} as any }
    }
    state.reminders.set(reminder.id, reminder)
    await saveReminder(reminder, ctx)
    const execution = executeReminder(reminder, ctx, state, config)
    await promptStarted
    const dir = await getStorageDir(ctx)
    await ctx.$`rm ${dir}/${reminder.id}.json`.quiet()
    await ctx.$`mkdir ${dir}/${reminder.id}.json`.quiet()
    finish()
    await execution

    expect(state.reminders.has(reminder.id)).toBe(true)
    expect(state.timers.has(reminder.id)).toBe(true)
  })

  test("cancellation aborts an active prompt and cannot reschedule it", async () => {
    const promptStarted = deferred<AbortSignal>()
    const finishPrompt = deferred()
    ;(ctx.client.session.prompt as any) = async (options: any) => {
      promptStarted.resolve(options.signal)
      await finishPrompt.promise
      return { data: {}, error: undefined, response: {} }
    }
    const reminder: Reminder = {
      id: "rem-active-cancel",
      sessionID: "ses-test",
      projectID: state.projectID,
      type: "recurring",
      interval: 60000,
      originalPrompt: "active cancellation",
      userDescription: "Active cancellation",
      time: { created: Date.now(), nextExecution: Date.now() + 5 },
      status: "active",
    }
    state.reminders.set(reminder.id, reminder)
    await scheduleTimer(reminder, ctx, state, config)

    const signal = await promptStarted.promise
    await cancelReminder(reminder.id, ctx, state)
    finishPrompt.resolve()
    const directory = await getStorageDir(ctx)
    await waitFor(async () => {
      const leases = await Array.fromAsync(new Bun.Glob("*.lease").scan({ cwd: directory }))
      return leases.length === 0
    })

    expect(signal.aborted).toBe(true)
    expect(await loadReminder(reminder.id, ctx)).toBeNull()
    expect(state.reminders.has(reminder.id)).toBe(false)
    expect(state.timers.has(reminder.id)).toBe(false)
  })

  test("replacement generation fences an active old occurrence", async () => {
    const promptStarted = deferred<AbortSignal>()
    const finishPrompt = deferred()
    ;(ctx.client.session.prompt as any) = async (options: any) => {
      promptStarted.resolve(options.signal)
      await finishPrompt.promise
      return { data: {}, error: undefined, response: {} }
    }
    const reminder: Reminder = {
      id: "rem-hot-reload",
      sessionID: "ses-test",
      projectID: state.projectID,
      type: "recurring",
      interval: 60000,
      originalPrompt: "hot reload",
      userDescription: "Hot reload",
      time: { created: Date.now(), nextExecution: Date.now() + 5 },
      status: "active",
    }
    state.reminders.set(reminder.id, reminder)
    await scheduleTimer(reminder, ctx, state, config)
    const oldSignal = await promptStarted.promise

    const replacement: State = {
      reminders: new Map(),
      timers: new Map(),
      projectID: state.projectID,
      generation: beginSchedulerGeneration(ctx),
    }
    const replacementReminder = structuredClone(reminder)
    replacementReminder.time.nextExecution = Date.now() + 60000
    replacement.reminders.set(reminder.id, replacementReminder)
    await scheduleTimer(replacementReminder, ctx, replacement, config)
    finishPrompt.resolve()
    await Bun.sleep(0)

    expect(oldSignal.aborted).toBe(true)
    expect(state.timers.has(reminder.id)).toBe(false)
    expect(replacement.timers.has(reminder.id)).toBe(true)
    expect((await loadReminder(reminder.id, ctx))?.time.nextExecution).toBe(
      replacementReminder.time.nextExecution,
    )
    await cancelReminder(reminder.id, ctx, replacement)
  })

  test("forwards a captured agent and omits it for legacy reminders", async () => {
    const bodies: any[] = []
    ;(ctx.client.session.prompt as any) = async (options: any) => {
      bodies.push(options.body)
      return { data: {}, error: undefined, response: {} }
    }
    const base: Reminder = {
      id: "rem-agent",
      sessionID: "ses-test",
      projectID: state.projectID,
      type: "one-time",
      interval: 1000,
      originalPrompt: "agent forwarding",
      userDescription: "Agent forwarding",
      time: { created: Date.now(), nextExecution: Date.now() + 1000 },
      status: "active",
    }
    const withAgent = { ...base, agent: "build" }
    state.reminders.set(withAgent.id, withAgent)
    await saveReminder(withAgent, ctx)
    await executeReminder(withAgent, ctx, state, config)

    const legacy = { ...base, id: "rem-legacy-agent" }
    state.reminders.set(legacy.id, legacy)
    await saveReminder(legacy, ctx)
    await executeReminder(legacy, ctx, state, config)

    expect(bodies[0].agent).toBe("build")
    expect(Object.hasOwn(bodies[1], "agent")).toBe(false)
  })
})
