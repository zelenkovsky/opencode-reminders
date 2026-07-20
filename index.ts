import { Plugin } from "@opencode-ai/plugin"
import { logger } from "./logger"
import type { State, PluginConfig } from "./types"
import { ReminderSchema } from "./types"
import { getStorageDir, listReminders } from "./storage"
import {
  beginSchedulerGeneration,
  finishSchedulerGeneration,
  isSchedulerGenerationCurrent,
  waitForSchedulerPersistence,
  scheduleTimer,
  cancelReminder,
  deleteStoredReminder,
} from "./scheduler"
import { createReminderAddTool } from "./tools/reminderadd"
import { createReminderListTool } from "./tools/reminderlist"
import { createReminderRemoveTool } from "./tools/reminderremove"

const RemindersPlugin: Plugin = async (ctx) => {
  const { project } = ctx
  const generation = beginSchedulerGeneration(ctx)

  logger.info(`[RemindersPlugin] Initializing for project ${project.id}`)

  await getStorageDir(ctx)

  const state: State = {
    reminders: new Map(),
    timers: new Map(),
    projectID: project.id,
    generation,
  }

  // Configuration with defaults
  let config: PluginConfig = {
    enabled: true,
    max_reminders_per_project: 50,
    min_interval_seconds: 30,
    notifications: {
      enabled: true,
    },
  }

  const gracePeriod = 60 * 60 * 1000
  const now = Date.now()
  let restoredCount = 0
  let expiredCount = 0
  let invalidCount = 0
  let healthyCount = 0

  if (!(await waitForSchedulerPersistence(ctx, generation))) {
    return {}
  }
  const storedReminders = await listReminders(ctx)
  if (!isSchedulerGenerationCurrent(ctx, generation)) {
    return {}
  }

  for (const reminder of storedReminders) {
    if (!isSchedulerGenerationCurrent(ctx, generation)) {
      return {}
    }
    try {
      ReminderSchema.parse(reminder)
    } catch (error) {
      logger.error(`[RemindersPlugin] Failed to restore reminder:`, error)
      if (reminder.id) {
        await deleteStoredReminder(reminder.id, ctx, state)
      }
      invalidCount++
      continue
    }

    try {
      // Skip session validation during startup - it may not be ready yet
      // Session cleanup will happen via event hook when session is actually deleted

      if (reminder.time.nextExecution + gracePeriod < now) {
        logger.info(`[RemindersPlugin] Reminder ${reminder.id} expired, removing`)
        await deleteStoredReminder(reminder.id, ctx, state)
        expiredCount++
        continue
      }

      state.reminders.set(reminder.id, reminder)
      const scheduled = await scheduleTimer(reminder, ctx, state, config, {
        persist: false,
        cleanupOnPersistenceFailure: false,
      })
      if (!isSchedulerGenerationCurrent(ctx, generation)) {
        return {}
      }

      // Validate timer was actually created (timer health validation)
      const isHealthy = scheduled && state.timers.has(reminder.id)
      if (isHealthy) {
        restoredCount++
        healthyCount++
        logger.info(`[RemindersPlugin] Restored and validated reminder ${reminder.id}`)
      } else {
        await deleteStoredReminder(reminder.id, ctx, state)
        state.reminders.delete(reminder.id)
        invalidCount++
        logger.error(`[RemindersPlugin] Timer restoration failed for ${reminder.id}, cancelled reminder`)
      }
    } catch (error) {
      // Keep a previously valid stored reminder after a transient scheduling or
      // persistence failure so a later initialization can retry it.
      logger.error(`[RemindersPlugin] Failed to schedule stored reminder ${reminder.id}:`, error)
      state.reminders.delete(reminder.id)
      invalidCount++
    }
  }

  await finishSchedulerGeneration(ctx, generation)
  if (!isSchedulerGenerationCurrent(ctx, generation)) {
    return {}
  }

  logger.info(
    `[RemindersPlugin] Timer persistence validation completed: ${storedReminders.length} total, ${restoredCount} restored, ${expiredCount} expired, ${invalidCount} invalid, ${healthyCount} healthy`,
  )

  // Cleanup considerations:
  // - timer.unref() allows clean exit without blocking the process
  // - Plugin API currently has no cleanup hook for graceful shutdown
  // - A replacement plugin generation clears timers and aborts active executions from the old generation
  // - Reminder state persists to storage and is restored on next startup
  // - Max reminders per project (50) bounds memory usage

  return {
    async config(cfg) {
      const cfgAny = cfg as any
      if (cfgAny.reminders) {
        config = { ...config, ...cfgAny.reminders }
        logger.info(`[RemindersPlugin] Configuration updated:`, config)
      }
    },

    async event({ event }) {
      if (event.type === "session.deleted") {
        const sessionID = event.properties.info.id
        logger.info(`[RemindersPlugin] Session ${sessionID} deleted, cleaning up reminders`)

        const remindersToCancel = Array.from(state.reminders.values()).filter((r) => r.sessionID === sessionID)

        let cancelledCount = 0
        for (const reminder of remindersToCancel) {
          if (await cancelReminder(reminder.id, ctx, state)) {
            cancelledCount++
          }
        }

        logger.info(`[RemindersPlugin] Cancelled ${cancelledCount} reminders for session ${sessionID}`)
      }
    },

    tool: {
      reminderadd: createReminderAddTool(ctx, state, () => config),
      reminderlist: createReminderListTool(state),
      reminderremove: createReminderRemoveTool(ctx, state),
    },
  }
}

export default RemindersPlugin
