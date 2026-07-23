import type { PluginInput } from "@opencode-ai/plugin"
import type { Reminder, State, PluginConfig } from "./types"
import { saveReminder, deleteReminder, loadReminder } from "./storage"
import { acquireExecutionLease, acquireMutationLock } from "./leases"
import { logger } from "./logger"

const RECONCILIATION_DELAY_MS = 250
type ScheduleOptions = { skipOverdue?: boolean }

export async function scheduleTimer(reminder: Reminder, ctx: PluginInput, state: State, config: PluginConfig, options: ScheduleOptions = {}): Promise<void> {
  const existing = state.timers.get(reminder.id)
  if (existing) clearTimeout(existing)
  const now = Date.now()
  const delay = Math.max(0, reminder.time.nextExecution - now)
  const skipOverdue = options.skipOverdue === true && reminder.time.nextExecution < now
  const timer = setTimeout(async () => {
    state.timers.delete(reminder.id)
    try {
      await executeReminder(reminder, ctx, state, config, skipOverdue)
    } catch (error) {
      logger.error(`Unhandled reminder timer failure ${reminder.id}:`, error)
      scheduleReconciliation(reminder.id, ctx, state, config)
    }
  }, delay)
  timer.unref()
  state.timers.set(reminder.id, timer)
}

function scheduleReconciliation(id: string, ctx: PluginInput, state: State, config: PluginConfig): void {
  const existing = state.timers.get(id)
  if (existing) clearTimeout(existing)
  const timer = setTimeout(async () => {
    state.timers.delete(id)
    await reconcileReminder(id, ctx, state, config)
  }, RECONCILIATION_DELAY_MS)
  timer.unref()
  state.timers.set(id, timer)
}

async function withMutationLock<T>(id: string, ctx: PluginInput, action: () => Promise<T>): Promise<T> {
  const lock = await acquireMutationLock(id, ctx)
  try {
    return await action()
  } finally {
    await lock.release()
  }
}

async function deleteReminderLocked(id: string, ctx: PluginInput, state: State): Promise<void> {
  const timer = state.timers.get(id)
  if (timer) clearTimeout(timer)
  state.timers.delete(id)
  state.reminders.delete(id)
  await deleteReminder(id, ctx)
}

export async function reconcileReminder(id: string, ctx: PluginInput, state: State, config: PluginConfig): Promise<void> {
  try {
    const stored = await loadReminder(id, ctx)
    if (!stored || stored.status !== "active") {
      const timer = state.timers.get(id)
      if (timer) clearTimeout(timer)
      state.timers.delete(id)
      state.reminders.delete(id)
      return
    }
    state.reminders.set(id, stored)
    await scheduleTimer(stored, ctx, state, config)
  } catch (error) {
    logger.error(`Failed to reconcile reminder ${id}:`, error)
    // Preserve in-memory state and retry an I/O/parse failure rather than consuming it.
    scheduleReconciliation(id, ctx, state, config)
  }
}

export async function cleanupReminderSnapshot(snapshot: Reminder, ctx: PluginInput, state: State, config: PluginConfig): Promise<boolean> {
  try {
    return await withMutationLock(snapshot.id, ctx, async () => {
      const current = await loadReminder(snapshot.id, ctx)
      if (!current || current.time.nextExecution !== snapshot.time.nextExecution) {
        await reconcileReminder(snapshot.id, ctx, state, config)
        return false
      }
      await deleteReminderLocked(snapshot.id, ctx, state)
      return true
    })
  } catch (error) {
    logger.error(`Failed conditional cleanup for reminder ${snapshot.id}:`, error)
    await reconcileReminder(snapshot.id, ctx, state, config)
    return false
  }
}

async function skipMissedRecurring(reminder: Reminder, occurrence: number, ctx: PluginInput, state: State, config: PluginConfig, skipOverdue: boolean): Promise<boolean> {
  if (!skipOverdue || reminder.type !== "recurring") return false
  let advanced = false
  await withMutationLock(reminder.id, ctx, async () => {
    const current = await loadReminder(reminder.id, ctx)
    if (!current || current.status !== "active" || current.time.nextExecution !== occurrence) return
    const missed = Math.ceil(Math.abs(Date.now() - occurrence) / current.interval)
    current.time.nextExecution = occurrence + missed * current.interval
    state.reminders.set(current.id, current)
    await saveReminder(current, ctx)
    await scheduleTimer(current, ctx, state, config)
    advanced = true
  })
  if (!advanced) await reconcileReminder(reminder.id, ctx, state, config)
  return true
}

async function handlePromptError(reminder: Reminder, occurrence: number, error: any, ctx: PluginInput, state: State, config: PluginConfig): Promise<void> {
  try {
    let changed = false
    await withMutationLock(reminder.id, ctx, async () => {
      const current = await loadReminder(reminder.id, ctx)
      if (!current || current.status !== "active" || current.time.nextExecution !== occurrence) return
      changed = true
      if (error?.name === "MessageAbortedError" && current.type === "recurring") {
        current.time.nextExecution = Date.now() + current.interval
        state.reminders.set(current.id, current)
        await saveReminder(current, ctx)
        await scheduleTimer(current, ctx, state, config)
      } else {
        await deleteReminderLocked(current.id, ctx, state)
      }
    })
    if (!changed) await reconcileReminder(reminder.id, ctx, state, config)
  } catch (mutationError) {
    logger.error(`Failed to handle reminder prompt error ${reminder.id}:`, mutationError)
    await reconcileReminder(reminder.id, ctx, state, config)
  }
}

export async function executeReminder(reminder: Reminder, ctx: PluginInput, state: State, config: PluginConfig, skipOverdue = false): Promise<void> {
  const occurrence = reminder.time.nextExecution
  const acquisition = await acquireExecutionLease(reminder.id, occurrence, ctx)
  if (acquisition.status !== "acquired") {
    if (acquisition.status === "error") logger.error(`Could not acquire reminder lease ${reminder.id}:`, acquisition.error)
    scheduleReconciliation(reminder.id, ctx, state, config)
    return
  }

  try {
    // Pre-prompt read/validation/skip failures only reconcile; they never delete or prompt.
    try {
      const stored = await loadReminder(reminder.id, ctx)
      if (!stored || stored.status !== "active" || stored.time.nextExecution !== occurrence) {
        await reconcileReminder(reminder.id, ctx, state, config)
        return
      }
      if (await skipMissedRecurring(stored, occurrence, ctx, state, config, skipOverdue)) return
    } catch (error) {
      logger.error(`Pre-prompt validation failed for reminder ${reminder.id}:`, error)
      await reconcileReminder(reminder.id, ctx, state, config)
      return
    }

    try {
      await ctx.client.session.prompt({ path: { id: reminder.sessionID }, body: { parts: [{ type: "text", text: reminder.originalPrompt }] } })
    } catch (error: any) {
      logger.error(`Reminder ${reminder.id} prompt failed:`, error)
      await handlePromptError(reminder, occurrence, error, ctx, state, config)
      return
    }

    // Prompt acceptance is separate from its durable transition. Never treat a failure here as a prompt error.
    try {
      const completed = await withMutationLock(reminder.id, ctx, async (): Promise<Reminder | null> => {
        const current = await loadReminder(reminder.id, ctx)
        if (!current || current.status !== "active" || current.time.nextExecution !== occurrence) return null
        current.time.lastExecution = Date.now()
        reminder.time.lastExecution = current.time.lastExecution
        if (current.type === "recurring") {
          current.time.nextExecution = Date.now() + current.interval
          state.reminders.set(current.id, current)
          await saveReminder(current, ctx)
          await scheduleTimer(current, ctx, state, config)
        } else {
          await deleteReminderLocked(current.id, ctx, state)
        }
        return current
      })
      if (!completed) await reconcileReminder(reminder.id, ctx, state, config)
      else if (config.notifications.enabled) {
        try {
          await ctx.client.tui.showToast({ body: { message: completed.type === "recurring" ? `Reminder executed: ${completed.userDescription}` : `Reminder completed: ${completed.userDescription}`, variant: "success" } })
        } catch (error) {
          logger.error(`Failed reminder toast ${reminder.id}:`, error)
        }
      }
    } catch (error) {
      logger.error(`Post-prompt transition failed for reminder ${reminder.id}:`, error)
      await reconcileReminder(reminder.id, ctx, state, config)
    }
  } finally {
    try {
      await acquisition.lease.release()
    } catch (error) {
      logger.error(`Failed to release reminder lease ${reminder.id}:`, error)
      scheduleReconciliation(reminder.id, ctx, state, config)
    }
  }
}

export async function cancelReminder(id: string, ctx: PluginInput, state: State): Promise<void> {
  try {
    await withMutationLock(id, ctx, async () => deleteReminderLocked(id, ctx, state))
    logger.info(`Reminder ${id} cancelled`)
  } catch (error) {
    logger.error(`Failed to cancel reminder ${id}:`, error)
    throw error
  }
}
