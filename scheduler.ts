import type { PluginInput } from "@opencode-ai/plugin"
import type { Reminder, State, PluginConfig } from "./types"
import { saveReminder, deleteReminder, loadReminder } from "./storage"
import { acquireExecutionLease, acquireMutationLock } from "./leases"
import { logger } from "./logger"

type ScheduledExecution = {
  generation: string
  token: string
  controller?: AbortController
  timer?: NodeJS.Timeout
  state: State
}

type ProjectRuntime = {
  generation: string
  executions: Map<string, ScheduledExecution>
  persistence: Map<string, Promise<unknown>>
  fences: Map<string, ReminderFence>
}

type ReminderFence = {
  version: number
  reconciliations: number
  tombstone: boolean
}

type ScheduleOptions = {
  persist?: boolean
  skipOverdue?: boolean
  retryAttempt?: number
}

const RECONCILIATION_DELAY_MS = 250
const MAX_RECONCILIATION_DELAY_MS = 30_000
const MAX_RECONCILIATION_ATTEMPT = 1 + Math.ceil(
  Math.log2(MAX_RECONCILIATION_DELAY_MS / RECONCILIATION_DELAY_MS),
)
const runtimesKey = Symbol.for("opencode-reminders.scheduler-runtimes")
const runtimes: Map<string, ProjectRuntime> =
  (globalThis as any)[runtimesKey] ?? ((globalThis as any)[runtimesKey] = new Map())

function projectKey(ctx: PluginInput): string {
  return `${ctx.directory}\0${ctx.project.id}`
}

function getRuntime(ctx: PluginInput): ProjectRuntime {
  const key = projectKey(ctx)
  let runtime = runtimes.get(key)
  if (!runtime) {
    runtime = {
      generation: crypto.randomUUID(),
      executions: new Map(),
      persistence: new Map(),
      fences: new Map(),
    }
    runtimes.set(key, runtime)
  }
  runtime.fences ??= new Map()
  return runtime
}

function stateGeneration(state: State, ctx: PluginInput): string {
  if (!state.generation) state.generation = getRuntime(ctx).generation
  return state.generation
}

function isCurrentGeneration(state: State, ctx: PluginInput): boolean {
  return stateGeneration(state, ctx) === getRuntime(ctx).generation
}

function isCurrentExecution(id: string, ctx: PluginInput, state: State, token: string): boolean {
  const runtime = getRuntime(ctx)
  const execution = runtime.executions.get(id)
  return (
    stateGeneration(state, ctx) === runtime.generation
    && execution?.generation === runtime.generation
    && execution.token === token
  )
}

function stopLocalExecution(id: string, runtime: ProjectRuntime): ScheduledExecution | undefined {
  const execution = runtime.executions.get(id)
  if (execution?.timer) clearTimeout(execution.timer)
  execution?.controller?.abort()
  execution?.state.timers.delete(id)
  runtime.executions.delete(id)
  return execution
}

export function beginSchedulerGeneration(ctx: PluginInput): string {
  const runtime = getRuntime(ctx)
  for (const id of Array.from(runtime.executions.keys())) stopLocalExecution(id, runtime)
  for (const [id, fence] of runtime.fences) retireFence(id, runtime, fence)
  runtime.generation = crypto.randomUUID()
  return runtime.generation
}

export function isSchedulerGenerationCurrent(ctx: PluginInput, generation: string): boolean {
  return getRuntime(ctx).generation === generation
}

export async function waitForSchedulerMutations(ctx: PluginInput, generation: string): Promise<boolean> {
  const runtime = getRuntime(ctx)
  while (runtime.generation === generation) {
    const pending = Array.from(runtime.persistence.values())
    if (pending.length === 0) return true
    await Promise.all(pending.map((operation) => operation.catch(() => {})))
  }
  return false
}

async function withMutationLock<T>(id: string, ctx: PluginInput, action: () => Promise<T>): Promise<T> {
  const runtime = getRuntime(ctx)
  const operationID = `${id}\0${crypto.randomUUID()}`
  const operation = (async () => {
    const lock = await acquireMutationLock(id, ctx)
    try {
      return await action()
    } finally {
      await lock.release()
    }
  })()
  runtime.persistence.set(operationID, operation)
  try {
    return await operation
  } finally {
    if (runtime.persistence.get(operationID) === operation) runtime.persistence.delete(operationID)
  }
}

function clearStateReminder(id: string, state: State): void {
  const timer = state.timers.get(id)
  if (timer) clearTimeout(timer)
  state.timers.delete(id)
  state.reminders.delete(id)
}

function beginReconciliation(id: string, runtime: ProjectRuntime): { fence: ReminderFence; version: number } {
  let fence = runtime.fences.get(id)
  if (!fence) {
    fence = { version: 0, reconciliations: 0, tombstone: false }
    runtime.fences.set(id, fence)
  }
  fence.reconciliations++
  return { fence, version: fence.version }
}

function reconciliationIsCurrent(
  id: string,
  runtime: ProjectRuntime,
  fence: ReminderFence,
  version: number,
): boolean {
  return runtime.fences.get(id) === fence && fence.version === version && !fence.tombstone
}

function finishReconciliation(id: string, runtime: ProjectRuntime, fence: ReminderFence): void {
  fence.reconciliations--
  retireFence(id, runtime, fence)
}

function invalidateReminder(id: string, runtime: ProjectRuntime): ReminderFence {
  let fence = runtime.fences.get(id)
  if (!fence) {
    fence = { version: 0, reconciliations: 0, tombstone: false }
    runtime.fences.set(id, fence)
  }
  fence.version++
  fence.tombstone = true
  return fence
}

function retireFence(id: string, runtime: ProjectRuntime, fence: ReminderFence): void {
  if (
    runtime.fences.get(id) === fence
    && fence.reconciliations === 0
    && !runtime.executions.has(id)
  ) {
    runtime.fences.delete(id)
  }
}

async function deleteReminderLocked(id: string, ctx: PluginInput, state: State): Promise<void> {
  const runtime = getRuntime(ctx)
  const fence = invalidateReminder(id, runtime)
  const execution = stopLocalExecution(id, runtime)
  clearStateReminder(id, state)
  if (execution && execution.state !== state) clearStateReminder(id, execution.state)
  try {
    await deleteReminder(id, ctx)
  } catch (error) {
    fence.tombstone = false
    throw error
  } finally {
    retireFence(id, runtime, fence)
  }
}

export async function deleteStoredReminder(id: string, ctx: PluginInput, state: State): Promise<void> {
  if (!isCurrentGeneration(state, ctx)) return
  await withMutationLock(id, ctx, async () => {
    if (isCurrentGeneration(state, ctx)) await deleteReminderLocked(id, ctx, state)
  })
}

export async function scheduleTimer(
  reminder: Reminder,
  ctx: PluginInput,
  state: State,
  config: PluginConfig,
  options: ScheduleOptions = {},
): Promise<boolean> {
  const runtime = getRuntime(ctx)
  const generation = stateGeneration(state, ctx)
  if (generation !== runtime.generation) {
    clearStateReminder(reminder.id, state)
    return false
  }

  stopLocalExecution(reminder.id, runtime)
  const token = crypto.randomUUID()
  const execution: ScheduledExecution = { generation, token, state }
  runtime.executions.set(reminder.id, execution)

  if (options.persist !== false) {
    const snapshot = structuredClone(reminder)
    try {
      await withMutationLock(reminder.id, ctx, async () => {
        if (isCurrentExecution(reminder.id, ctx, state, token)) await saveReminder(snapshot, ctx)
      })
    } catch (error) {
      if (isCurrentExecution(reminder.id, ctx, state, token)) {
        stopLocalExecution(reminder.id, runtime)
        clearStateReminder(reminder.id, state)
      }
      throw error
    }
    if (!isCurrentExecution(reminder.id, ctx, state, token)) {
      clearStateReminder(reminder.id, state)
      return false
    }
  }

  const now = Date.now()
  const delay = Math.max(0, reminder.time.nextExecution - now)
  const skipOverdue = options.skipOverdue === true && reminder.time.nextExecution < now
  const retryAttempt = reminder.time.nextExecution < now ? options.retryAttempt ?? 0 : 0
  const timer = setTimeout(async () => {
    if (state.timers.get(reminder.id) === timer) state.timers.delete(reminder.id)
    if (!isCurrentExecution(reminder.id, ctx, state, token)) return

    const controller = new AbortController()
    execution.timer = undefined
    execution.controller = controller
    try {
      await executeReminder(reminder, ctx, state, config, skipOverdue, retryAttempt, token, controller.signal)
    } catch (error) {
      logger.error(`Unhandled reminder timer failure ${reminder.id}:`, error)
      if (isCurrentExecution(reminder.id, ctx, state, token)) {
        scheduleReconciliation(reminder.id, ctx, state, config, { skipOverdue, retryAttempt })
      }
    }
  }, delay)
  timer.unref()
  execution.timer = timer
  state.timers.set(reminder.id, timer)
  return true
}

function scheduleReconciliation(
  id: string,
  ctx: PluginInput,
  state: State,
  config: PluginConfig,
  options: ScheduleOptions = {},
): void {
  if (!isCurrentGeneration(state, ctx)) return
  const existing = state.timers.get(id)
  if (existing) clearTimeout(existing)
  const generation = stateGeneration(state, ctx)
  const retryAttempt = Math.min((options.retryAttempt ?? 0) + 1, MAX_RECONCILIATION_ATTEMPT)
  const delay = Math.min(
    RECONCILIATION_DELAY_MS * (2 ** (retryAttempt - 1)),
    MAX_RECONCILIATION_DELAY_MS,
  )
  const timer = setTimeout(async () => {
    if (state.timers.get(id) === timer) state.timers.delete(id)
    const execution = getRuntime(ctx).executions.get(id)
    if (execution?.timer === timer) execution.timer = undefined
    if (!isSchedulerGenerationCurrent(ctx, generation)) return
    await reconcileReminder(id, ctx, state, config, {
      skipOverdue: options.skipOverdue,
      retryAttempt,
    })
  }, delay)
  timer.unref()
  state.timers.set(id, timer)
  const execution = getRuntime(ctx).executions.get(id)
  if (execution?.generation === generation) execution.timer = timer
}

export async function reconcileReminder(
  id: string,
  ctx: PluginInput,
  state: State,
  config: PluginConfig,
  options: ScheduleOptions = {},
): Promise<void> {
  if (!isCurrentGeneration(state, ctx)) return
  const runtime = getRuntime(ctx)
  const { fence, version } = beginReconciliation(id, runtime)
  try {
    await loadReminder(id, ctx)
    if (
      !isCurrentGeneration(state, ctx)
      || !reconciliationIsCurrent(id, runtime, fence, version)
    ) return

    await withMutationLock(id, ctx, async () => {
      if (
        !isCurrentGeneration(state, ctx)
        || !reconciliationIsCurrent(id, runtime, fence, version)
      ) return

      // Re-read under the mutation lock so a cancellation in another process cannot
      // be followed by restoration from the optimistic snapshot above.
      const stored = await loadReminder(id, ctx)
      if (
        !isCurrentGeneration(state, ctx)
        || !reconciliationIsCurrent(id, runtime, fence, version)
      ) return
      if (!stored || stored.status !== "active") {
        clearStateReminder(id, state)
        return
      }
      state.reminders.set(id, stored)
      await scheduleTimer(stored, ctx, state, config, {
        persist: false,
        skipOverdue: options.skipOverdue,
        retryAttempt: options.retryAttempt,
      })
    })
  } catch (error) {
    logger.error(`Failed to reconcile reminder ${id}:`, error)
    if (reconciliationIsCurrent(id, runtime, fence, version)) {
      scheduleReconciliation(id, ctx, state, config, options)
    }
  } finally {
    finishReconciliation(id, runtime, fence)
  }
}

export async function cleanupReminderSnapshot(
  snapshot: Reminder,
  ctx: PluginInput,
  state: State,
  config: PluginConfig,
): Promise<boolean> {
  if (!isCurrentGeneration(state, ctx)) return false
  try {
    let cleaned = false
    await withMutationLock(snapshot.id, ctx, async () => {
      if (!isCurrentGeneration(state, ctx)) return
      const current = await loadReminder(snapshot.id, ctx)
      if (!current || current.time.nextExecution !== snapshot.time.nextExecution) return
      await deleteReminderLocked(snapshot.id, ctx, state)
      cleaned = true
    })
    if (!cleaned) await reconcileReminder(snapshot.id, ctx, state, config)
    return cleaned
  } catch (error) {
    logger.error(`Failed conditional cleanup for reminder ${snapshot.id}:`, error)
    await reconcileReminder(snapshot.id, ctx, state, config)
    return false
  }
}

async function skipMissedRecurring(
  reminder: Reminder,
  occurrence: number,
  ctx: PluginInput,
  state: State,
  config: PluginConfig,
  skipOverdue: boolean,
  retryAttempt: number,
): Promise<boolean> {
  if (!skipOverdue || reminder.type !== "recurring") return false
  let advanced = false
  await withMutationLock(reminder.id, ctx, async () => {
    const current = await loadReminder(reminder.id, ctx)
    if (!current || current.status !== "active" || current.time.nextExecution !== occurrence) return
    const missed = Math.ceil(Math.abs(Date.now() - occurrence) / current.interval)
    current.time.nextExecution = occurrence + missed * current.interval
    await saveReminder(current, ctx)
    if (isCurrentGeneration(state, ctx)) {
      state.reminders.set(current.id, current)
      await scheduleTimer(current, ctx, state, config, { persist: false })
    }
    advanced = true
  })
  if (!advanced) {
    await reconcileReminder(reminder.id, ctx, state, config, { skipOverdue, retryAttempt })
  }
  return true
}

async function handlePromptError(
  reminder: Reminder,
  occurrence: number,
  error: any,
  ctx: PluginInput,
  state: State,
  config: PluginConfig,
  retryAttempt: number,
): Promise<void> {
  try {
    let changed = false
    await withMutationLock(reminder.id, ctx, async () => {
      const current = await loadReminder(reminder.id, ctx)
      if (!current || current.status !== "active" || current.time.nextExecution !== occurrence) return
      changed = true
      if (error?.name === "MessageAbortedError" && current.type === "recurring") {
        current.time.nextExecution = Date.now() + current.interval
        await saveReminder(current, ctx)
        if (isCurrentGeneration(state, ctx)) {
          state.reminders.set(current.id, current)
          await scheduleTimer(current, ctx, state, config, { persist: false })
        }
      } else {
        await deleteReminderLocked(current.id, ctx, state)
      }
    })
    if (!changed) await reconcileReminder(reminder.id, ctx, state, config, { retryAttempt })
  } catch (mutationError) {
    logger.error(`Failed to handle reminder prompt error ${reminder.id}:`, mutationError)
    scheduleReconciliation(reminder.id, ctx, state, config, { retryAttempt })
  }
}

export async function executeReminder(
  reminder: Reminder,
  ctx: PluginInput,
  state: State,
  config: PluginConfig,
  skipOverdue = false,
  retryAttempt = 0,
  token?: string,
  signal?: AbortSignal,
): Promise<void> {
  const runtime = getRuntime(ctx)
  if (!token) {
    if (!isCurrentGeneration(state, ctx)) return
    stopLocalExecution(reminder.id, runtime)
    token = crypto.randomUUID()
    const controller = new AbortController()
    signal = controller.signal
    runtime.executions.set(reminder.id, {
      generation: stateGeneration(state, ctx),
      token,
      controller,
      state,
    })
  }

  const occurrence = reminder.time.nextExecution
  const acquisition = await acquireExecutionLease(reminder.id, occurrence, ctx)
  if (acquisition.status !== "acquired") {
    if (acquisition.status === "error") {
      logger.error(`Could not acquire reminder lease ${reminder.id}:`, acquisition.error)
    }
    if (isCurrentExecution(reminder.id, ctx, state, token)) {
      scheduleReconciliation(reminder.id, ctx, state, config, { skipOverdue, retryAttempt })
    }
    return
  }

  try {
    try {
      const stored = await loadReminder(reminder.id, ctx)
      if (!isCurrentExecution(reminder.id, ctx, state, token)) return
      if (!stored || stored.status !== "active" || stored.time.nextExecution !== occurrence) {
        await reconcileReminder(reminder.id, ctx, state, config, { skipOverdue, retryAttempt })
        return
      }
      if (await skipMissedRecurring(
        stored,
        occurrence,
        ctx,
        state,
        config,
        skipOverdue,
        retryAttempt,
      )) return
    } catch (error) {
      logger.error(`Pre-prompt validation failed for reminder ${reminder.id}:`, error)
      scheduleReconciliation(reminder.id, ctx, state, config, { skipOverdue, retryAttempt })
      return
    }

    try {
      await ctx.client.session.prompt({
        path: { id: reminder.sessionID },
        signal,
        body: {
          parts: [{ type: "text", text: reminder.originalPrompt }],
          ...(reminder.agent === undefined ? {} : { agent: reminder.agent }),
        },
      })
    } catch (error: any) {
      if (!isCurrentExecution(reminder.id, ctx, state, token)) return
      logger.error(`Reminder ${reminder.id} prompt failed:`, error)
      await handlePromptError(reminder, occurrence, error, ctx, state, config, retryAttempt)
      return
    }

    // A stale generation may finish after an API ignores abort. Its occurrence lease and
    // conditional durable transition still prevent resurrection or a duplicate local prompt.
    try {
      const completed = await withMutationLock<Reminder | null>(reminder.id, ctx, async () => {
        const current = await loadReminder(reminder.id, ctx)
        if (!current || current.status !== "active" || current.time.nextExecution !== occurrence) return null
        current.time.lastExecution = Date.now()
        reminder.time.lastExecution = current.time.lastExecution
        if (current.type === "recurring") {
          current.time.nextExecution = Date.now() + current.interval
          await saveReminder(current, ctx)
          if (isCurrentExecution(reminder.id, ctx, state, token)) {
            state.reminders.set(current.id, current)
            await scheduleTimer(current, ctx, state, config, { persist: false })
          }
        } else {
          await deleteReminderLocked(current.id, ctx, state)
        }
        return current
      })
      if (!completed) await reconcileReminder(reminder.id, ctx, state, config, { retryAttempt })
      else if (config.notifications.enabled && isCurrentGeneration(state, ctx)) {
        try {
          await ctx.client.tui.showToast({
            body: {
              message: completed.type === "recurring"
                ? `Reminder executed: ${completed.userDescription}`
                : `Reminder completed: ${completed.userDescription}`,
              variant: "success",
            },
          })
        } catch (error) {
          logger.error(`Failed reminder toast ${reminder.id}:`, error)
        }
      }
    } catch (error) {
      logger.error(`Post-prompt transition failed for reminder ${reminder.id}:`, error)
      scheduleReconciliation(reminder.id, ctx, state, config, { retryAttempt })
    }
  } finally {
    try {
      await acquisition.lease.release()
    } catch (error) {
      logger.error(`Failed to release reminder lease ${reminder.id}:`, error)
      if (isCurrentGeneration(state, ctx)) {
        scheduleReconciliation(reminder.id, ctx, state, config, { skipOverdue, retryAttempt })
      }
    }
  }
}

export async function cancelReminder(id: string, ctx: PluginInput, state: State): Promise<boolean> {
  const runtime = getRuntime(ctx)
  const fence = invalidateReminder(id, runtime)
  const execution = stopLocalExecution(id, runtime)
  clearStateReminder(id, state)
  if (execution && execution.state !== state) clearStateReminder(id, execution.state)
  try {
    await withMutationLock(id, ctx, async () => {
      await deleteReminder(id, ctx)
      const replacement = stopLocalExecution(id, runtime)
      clearStateReminder(id, state)
      if (replacement && replacement.state !== state) clearStateReminder(id, replacement.state)
    })
    retireFence(id, runtime, fence)
    logger.info(`Reminder ${id} cancelled`)
    return true
  } catch (error) {
    fence.tombstone = false
    retireFence(id, runtime, fence)
    logger.error(`Failed to cancel reminder ${id}:`, error)
    throw error
  }
}
