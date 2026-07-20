import type { PluginInput } from "@opencode-ai/plugin"
import type { Reminder, State, PluginConfig } from "./types"
import { saveReminder, deleteReminder } from "./storage"
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
  initializing: boolean
  executions: Map<string, ScheduledExecution>
  persistence: Map<string, Promise<void>>
  cancelled: Map<string, { deleted: boolean }>
}

type ScheduleOptions = {
  persist?: boolean
  cleanupOnPersistenceFailure?: boolean
}

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
      initializing: false,
      executions: new Map(),
      persistence: new Map(),
      cancelled: new Map(),
    }
    runtimes.set(key, runtime)
  }
  return runtime
}

export function beginSchedulerGeneration(ctx: PluginInput): string {
  const runtime = getRuntime(ctx)
  for (const [id, execution] of runtime.executions) {
    if (execution.timer) {
      clearTimeout(execution.timer)
    }
    execution.controller?.abort()
    execution.state.timers.delete(id)
  }
  runtime.executions.clear()
  runtime.generation = crypto.randomUUID()
  runtime.initializing = true
  return runtime.generation
}

export function isSchedulerGenerationCurrent(ctx: PluginInput, generation: string): boolean {
  return getRuntime(ctx).generation === generation
}

export async function waitForSchedulerPersistence(ctx: PluginInput, generation: string): Promise<boolean> {
  const runtime = getRuntime(ctx)
  while (runtime.generation === generation) {
    const pending = Array.from(runtime.persistence.values())
    if (pending.length === 0) {
      return true
    }
    await Promise.all(pending.map((operation) => operation.catch(() => {})))
  }
  return false
}

export async function finishSchedulerGeneration(ctx: PluginInput, generation: string): Promise<void> {
  const runtime = getRuntime(ctx)
  await Promise.all(Array.from(runtime.persistence.values(), (operation) => operation.catch(() => {})))
  if (runtime.generation === generation) {
    runtime.initializing = false
    for (const [id, tombstone] of runtime.cancelled) {
      if (tombstone.deleted) {
        runtime.cancelled.delete(id)
      }
    }
  }
}

function stateGeneration(state: State, ctx: PluginInput): string {
  if (!state.generation) {
    state.generation = getRuntime(ctx).generation
  }
  return state.generation
}

function isCurrentGeneration(state: State, ctx: PluginInput): boolean {
  return stateGeneration(state, ctx) === getRuntime(ctx).generation
}

function isCurrentExecution(id: string, ctx: PluginInput, state: State, token: string): boolean {
  const runtime = getRuntime(ctx)
  const execution = runtime.executions.get(id)
  return (
    stateGeneration(state, ctx) === runtime.generation &&
    execution?.generation === runtime.generation &&
    execution.token === token
  )
}

async function queuePersistence(
  id: string,
  ctx: PluginInput,
  operation: () => Promise<void>,
): Promise<void> {
  const runtime = getRuntime(ctx)
  const previous = runtime.persistence.get(id) ?? Promise.resolve()
  const current = previous.catch(() => {}).then(operation)
  runtime.persistence.set(id, current)
  try {
    await current
  } finally {
    if (runtime.persistence.get(id) === current) {
      runtime.persistence.delete(id)
    }
  }
}

async function persistCurrentReminder(
  reminder: Reminder,
  ctx: PluginInput,
  state: State,
  token: string,
): Promise<boolean> {
  const snapshot = structuredClone(reminder)
  await queuePersistence(reminder.id, ctx, async () => {
    if (isCurrentExecution(reminder.id, ctx, state, token)) {
      await saveReminder(snapshot, ctx)
    }
  })
  return isCurrentExecution(reminder.id, ctx, state, token)
}

async function deleteCurrentStoredReminder(id: string, ctx: PluginInput): Promise<void> {
  const runtime = getRuntime(ctx)
  const tombstone = runtime.cancelled.get(id) ?? { deleted: false }
  runtime.cancelled.set(id, tombstone)
  await queuePersistence(id, ctx, async () => {
    if (runtime.cancelled.get(id) === tombstone) {
      await deleteReminder(id, ctx)
      tombstone.deleted = true
    }
  })
  if (!runtime.initializing && tombstone.deleted && runtime.cancelled.get(id) === tombstone) {
    runtime.cancelled.delete(id)
  }
}

export async function deleteStoredReminder(id: string, ctx: PluginInput, state: State): Promise<void> {
  if (!isCurrentGeneration(state, ctx)) {
    return
  }
  await deleteCurrentStoredReminder(id, ctx)
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
    state.reminders.delete(reminder.id)
    return false
  }
  if (runtime.cancelled.has(reminder.id)) {
    state.reminders.delete(reminder.id)
    await deleteStoredReminder(reminder.id, ctx, state)
    return false
  }

  const existingTimer = state.timers.get(reminder.id)
  if (existingTimer) {
    clearTimeout(existingTimer)
  }

  const existingExecution = runtime.executions.get(reminder.id)
  if (existingExecution?.timer) {
    clearTimeout(existingExecution.timer)
    existingExecution.state.timers.delete(reminder.id)
  }
  existingExecution?.controller?.abort()
  const token = crypto.randomUUID()
  const execution: ScheduledExecution = { generation, token, state }
  runtime.executions.set(reminder.id, execution)

  const now = Date.now()
  let delay = reminder.time.nextExecution - now
  let shouldPersist = options.persist ?? true

  // Handle missed execution windows for recurring reminders
  if (delay < 0 && reminder.type === "recurring") {
    // Calculate how many intervals were missed
    const missedIntervals = Math.ceil(Math.abs(delay) / reminder.interval)
    // Schedule for next interval from the original scheduled time to maintain cadence
    reminder.time.nextExecution = reminder.time.nextExecution + (missedIntervals * reminder.interval)
    delay = reminder.time.nextExecution - now
    shouldPersist = true
    logger.info(
      `[RemindersPlugin] Skipped ${missedIntervals} missed execution(s) for recurring reminder ${reminder.id}`,
    )
  } else {
    // For one-time reminders or on-time recurring, use the scheduled time
    delay = Math.max(0, delay)
  }

  try {
    if (shouldPersist && !(await persistCurrentReminder(reminder, ctx, state, token))) {
      return false
    }
  } catch (error) {
    if (isCurrentExecution(reminder.id, ctx, state, token)) {
      runtime.executions.delete(reminder.id)
      state.reminders.delete(reminder.id)
      if (options.cleanupOnPersistenceFailure !== false) {
        try {
          await deleteStoredReminder(reminder.id, ctx, state)
        } catch (cleanupError) {
          logger.error(`Failed to clean up reminder ${reminder.id} after persistence failure:`, cleanupError)
        }
      }
    }
    throw error
  }

  const timer = setTimeout(async () => {
    if (state.timers.get(reminder.id) === timer) {
      state.timers.delete(reminder.id)
    }

    if (!isCurrentExecution(reminder.id, ctx, state, token)) {
      return
    }

    const controller = new AbortController()
    execution.timer = undefined
    execution.controller = controller
    await executeReminder(reminder, ctx, state, config, token, controller.signal)
  }, delay)

  // CRITICAL: Allow process to exit even with active timers
  timer.unref()

  execution.timer = timer
  state.timers.set(reminder.id, timer)

  logger.info(`Scheduled reminder ${reminder.id} to execute in ${Math.round(delay / 1000)}s`)
  return true
}

export async function executeReminder(
  reminder: Reminder,
  ctx: PluginInput,
  state: State,
  config: PluginConfig,
  token?: string,
  signal?: AbortSignal,
): Promise<void> {
  if (!token) {
    const runtime = getRuntime(ctx)
    if (!isCurrentGeneration(state, ctx) || runtime.cancelled.has(reminder.id)) {
      return
    }
    const existingExecution = runtime.executions.get(reminder.id)
    if (existingExecution?.timer) {
      clearTimeout(existingExecution.timer)
      existingExecution.state.timers.delete(reminder.id)
    }
    existingExecution?.controller?.abort()
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

  logger.info(`Executing reminder ${reminder.id}: ${reminder.userDescription}`)

  try {
    await ctx.client.session.prompt({
      path: { id: reminder.sessionID },
      signal,
      body: {
        parts: [
          {
            type: "text",
            text: reminder.originalPrompt,
          },
        ],
      },
    })

    if (!isCurrentExecution(reminder.id, ctx, state, token)) {
      return
    }

    reminder.time.lastExecution = Date.now()

    if (reminder.type === "recurring") {
      reminder.time.nextExecution = Date.now() + reminder.interval
      state.reminders.set(reminder.id, reminder)
      try {
        if (!(await scheduleTimer(reminder, ctx, state, config))) {
          return
        }
      } catch (error) {
        logger.error(`Failed to reschedule recurring reminder ${reminder.id}:`, error)
        throw error
      }
      logger.info(`Recurring reminder ${reminder.id} rescheduled`)
      
      if (config.notifications.enabled) {
        await ctx.client.tui.showToast({
          body: {
            message: `Reminder executed: ${reminder.userDescription}`,
            variant: "success",
          },
        })
      }
    } else {
      try {
        await cancelReminder(reminder.id, ctx, state, token)
      } catch (error) {
        logger.error(`Failed to remove completed reminder ${reminder.id}:`, error)
        throw error
      }
      logger.info(`One-time reminder ${reminder.id} completed and removed`)

      if (config.notifications.enabled) {
        await ctx.client.tui.showToast({
          body: {
            message: `Reminder completed: ${reminder.userDescription}`,
            variant: "success",
          },
        })
      }
    }
  } catch (error: any) {
    if (!isCurrentExecution(reminder.id, ctx, state, token)) {
      return
    }

    logger.error(`Reminder ${reminder.id} execution failed:`, error)

    if (config.notifications.enabled) {
      try {
        await ctx.client.tui.showToast({
          body: {
            title: "Reminder Failed",
            message: reminder.userDescription,
            variant: "error",
          },
        })
      } catch (notificationError) {
        logger.error(`Failed to show error notification for reminder ${reminder.id}:`, notificationError)
      }
    }

    if (!isCurrentExecution(reminder.id, ctx, state, token)) {
      return
    }

    if (error?.name === "MessageAbortedError") {
      if (reminder.type === "recurring") {
        reminder.time.nextExecution = Date.now() + reminder.interval
        state.reminders.set(reminder.id, reminder)
        try {
          if (!(await scheduleTimer(reminder, ctx, state, config))) {
            return
          }
        } catch (rescheduleError) {
          logger.error(`Failed to reschedule aborted reminder ${reminder.id}:`, rescheduleError)
          throw rescheduleError
        }
        logger.info(`Recurring reminder ${reminder.id} rescheduled after abort`)
      } else {
        await cancelReminder(reminder.id, ctx, state, token)
        logger.info(`One-time reminder ${reminder.id} cancelled after abort`)
      }
    } else {
      await cancelReminder(reminder.id, ctx, state, token)
      logger.info(`Reminder ${reminder.id} cancelled due to error`)
    }
  }
}

export async function cancelReminder(
  id: string,
  ctx: PluginInput,
  state: State,
  token?: string,
): Promise<boolean> {
  const runtime = getRuntime(ctx)
  const execution = runtime.executions.get(id)
  if (token && execution?.token !== token) {
    return false
  }

  if (execution?.timer) {
    clearTimeout(execution.timer)
    execution.state.timers.delete(id)
  }
  execution?.controller?.abort()
  runtime.executions.delete(id)

  const timer = state.timers.get(id)
  if (timer) {
    clearTimeout(timer)
    state.timers.delete(id)
  }

  state.reminders.delete(id)

  if (execution?.state !== state) {
    execution?.state.reminders.delete(id)
  }

  // Tool calls and events from a replaced plugin instance still express a current
  // user/session cancellation. Token-bound callbacks remain fenced above.
  await deleteCurrentStoredReminder(id, ctx)

  logger.info(`Reminder ${id} cancelled`)
  return true
}
