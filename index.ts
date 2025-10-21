import { Plugin } from "@opencode-ai/plugin"
import type { State } from "./types"
import { ReminderSchema } from "./types"
import { getStorageDir, deleteReminder, listReminders } from "./storage"
import { scheduleTimer, cancelReminder } from "./scheduler"
import { createReminderAddTool } from "./tools/reminderadd"
import { createReminderListTool } from "./tools/reminderlist"
import { createReminderRemoveTool } from "./tools/reminderremove"

const RemindersPlugin: Plugin = async (ctx) => {
  const { client, project } = ctx

  console.log(`[RemindersPlugin] Initializing for project ${project.id}`)

  await getStorageDir(ctx)

  const state: State = {
    reminders: new Map(),
    timers: new Map(),
    projectID: project.id,
  }

  // Configuration with defaults
  let config = {
    enabled: true,
    max_reminders_per_project: 50,
    min_interval_seconds: 30,
  }

  const gracePeriod = 60 * 60 * 1000
  const now = Date.now()
  let restoredCount = 0
  let expiredCount = 0
  let invalidCount = 0
  let healthyCount = 0

  const storedReminders = await listReminders(ctx)

  for (const reminder of storedReminders) {
    try {
      ReminderSchema.parse(reminder)

      // Skip session validation during startup - it may not be ready yet
      // Session cleanup will happen via event hook when session is actually deleted

      if (reminder.time.nextExecution + gracePeriod < now) {
        console.log(`[RemindersPlugin] Reminder ${reminder.id} expired, removing`)
        await deleteReminder(reminder.id, ctx)
        expiredCount++
        continue
      }

      state.reminders.set(reminder.id, reminder)
      await scheduleTimer(reminder, ctx, state)

      // Validate timer was actually created (timer health validation)
      const isHealthy = state.timers.has(reminder.id)
      if (isHealthy) {
        restoredCount++
        healthyCount++
        console.log(`[RemindersPlugin] Restored and validated reminder ${reminder.id}`)
      } else {
        await deleteReminder(reminder.id, ctx)
        state.reminders.delete(reminder.id)
        invalidCount++
        console.warn(`[RemindersPlugin] Timer restoration failed for ${reminder.id}, cancelled reminder`)
      }
    } catch (error) {
      console.error(`[RemindersPlugin] Failed to restore reminder:`, error)
      if (reminder.id) {
        await deleteReminder(reminder.id, ctx)
      }
      invalidCount++
    }
  }

  console.log(
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
        console.log(`[RemindersPlugin] Configuration updated:`, config)
      }
    },

    async event({ event }) {
      if (event.type === "session.deleted") {
        const sessionID = event.properties.info.id
        console.log(`[RemindersPlugin] Session ${sessionID} deleted, cleaning up reminders`)

        const remindersToCancel = Array.from(state.reminders.values()).filter((r) => r.sessionID === sessionID)

        for (const reminder of remindersToCancel) {
          await cancelReminder(reminder.id, ctx, state)
        }

        console.log(`[RemindersPlugin] Cancelled ${remindersToCancel.length} reminders for session ${sessionID}`)
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
