import { Plugin } from "@opencode-ai/plugin"
import { logger } from "./logger"
import type { State, PluginConfig } from "./types"
import { ReminderSchema } from "./types"
import { getStorageDir, listReminders } from "./storage"
import { scheduleTimer, cancelReminder, cleanupReminderSnapshot } from "./scheduler"
import { createReminderAddTool } from "./tools/reminderadd"
import { createReminderListTool } from "./tools/reminderlist"
import { createReminderRemoveTool } from "./tools/reminderremove"

const RemindersPlugin: Plugin = async (ctx) => {
  const { project } = ctx

  logger.info(`[RemindersPlugin] Initializing for project ${project.id}`)

  await getStorageDir(ctx)

  const state: State = {
    reminders: new Map(),
    timers: new Map(),
    projectID: project.id,
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

  const storedReminders = await listReminders(ctx)

  for (const snapshot of storedReminders) {
    const parsed = ReminderSchema.safeParse(snapshot)
    // Persisted filenames are derived from IDs. Only generated UUID snapshots with safe
    // timestamps may be re-opened or cleaned; malformed files are left for manual repair.
    if (!parsed.success || !isSafeRestoredReminder(parsed.data)) {
      logger.error(`[RemindersPlugin] Invalid restored reminder left untouched`)
      invalidCount++
      continue
    }
    const reminder = parsed.data
    try {
      // Skip session validation during startup - it may not be ready yet
      // Session cleanup will happen via event hook when session is actually deleted

      if (reminder.time.nextExecution + gracePeriod < now) {
        if (await cleanupReminderSnapshot(reminder, ctx, state, config)) {
          logger.info(`[RemindersPlugin] Reminder ${reminder.id} expired, removing`)
          expiredCount++
        }
        continue
      }

      state.reminders.set(reminder.id, reminder)
      await scheduleTimer(reminder, ctx, state, config, { skipOverdue: true })

      // Validate timer was actually created (timer health validation)
      const isHealthy = state.timers.has(reminder.id)
      if (isHealthy) {
        restoredCount++
        healthyCount++
        logger.info(`[RemindersPlugin] Restored and validated reminder ${reminder.id}`)
      } else {
        await cleanupReminderSnapshot(reminder, ctx, state, config)
        state.reminders.delete(reminder.id)
        invalidCount++
        logger.error(`[RemindersPlugin] Timer restoration failed for ${reminder.id}, cancelled reminder`)
      }
    } catch (error) {
      logger.error(`[RemindersPlugin] Failed to restore reminder:`, error)
      await cleanupReminderSnapshot(reminder, ctx, state, config)
      invalidCount++
    }
  }

  logger.info(
    `[RemindersPlugin] Timer persistence validation completed: ${storedReminders.length} total, ${restoredCount} restored, ${expiredCount} expired, ${invalidCount} invalid, ${healthyCount} healthy`,
  )

  // Cleanup considerations:
  // - timer.unref() allows clean exit without blocking the process
  // - Plugin API currently has no cleanup hook for graceful shutdown
  // - On hot-reload, old timers may fire once but won't be rescheduled (state is in new instance)
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

        for (const reminder of remindersToCancel) {
          await cancelReminder(reminder.id, ctx, state)
        }

        logger.info(`[RemindersPlugin] Cancelled ${remindersToCancel.length} reminders for session ${sessionID}`)
      }
    },

    tool: {
      reminderadd: createReminderAddTool(ctx, state, () => config),
      reminderlist: createReminderListTool(state),
      reminderremove: createReminderRemoveTool(ctx, state),
    },
  }
}

function isSafeRestoredReminder(reminder: { id: string; time: { nextExecution: number; created: number } }): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(reminder.id)
    && Number.isSafeInteger(reminder.time.created)
    && Number.isSafeInteger(reminder.time.nextExecution)
}

export default RemindersPlugin
