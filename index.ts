import { Plugin, tool } from "@opencode-ai/plugin"
import type { Reminder, State } from "./types"
import { ReminderSchema } from "./types"
import { getStorageDir, saveReminder, deleteReminder, listReminders } from "./storage"
import { scheduleTimer, cancelReminder } from "./scheduler"
import REMINDERADD_DESCRIPTION from "./tools/reminderadd.txt"
import REMINDERLIST_DESCRIPTION from "./tools/reminderlist.txt"
import REMINDERREMOVE_DESCRIPTION from "./tools/reminderremove.txt"

export const RemindersPlugin: Plugin = async (ctx) => {
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

      try {
        await client.session.get({ path: { id: reminder.sessionID } })
      } catch {
        console.log(
          `[RemindersPlugin] Session ${reminder.sessionID} no longer exists, removing reminder ${reminder.id}`,
        )
        await deleteReminder(reminder.id, ctx)
        invalidCount++
        continue
      }

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

  process.on("beforeExit", () => {
    console.log(`[RemindersPlugin] Cleaning up ${state.timers.size} timers`)
    for (const timer of state.timers.values()) {
      clearTimeout(timer)
    }
  })

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
      reminderadd: tool({
        description: REMINDERADD_DESCRIPTION,

        args: {
          interval_seconds: tool.schema.number().min(30).describe("Time interval in seconds (minimum 30)"),
          type: tool.schema.enum(["one-time", "recurring"]).describe("Whether this reminder runs once or repeatedly"),
          action_prompt: tool.schema
            .string()
            .describe("Fully resolved action with absolute paths and specific identifiers"),
          description: tool.schema.string().describe("Human-readable description for identification"),
        },

        async execute(args, context) {
          const maxReminders = config.max_reminders_per_project
          const existingCount = Array.from(state.reminders.values()).filter(
            (r) => r.sessionID === context.sessionID,
          ).length

          if (existingCount >= maxReminders) {
            const reminders = Array.from(state.reminders.values()).filter((r) => r.sessionID === context.sessionID)
            return `Can't set more reminders, too many reminders already active (${existingCount}/${maxReminders}). Current reminders:\n${reminders.map((r) => `- ${r.userDescription}`).join("\n")}`
          }

          const reminder: Reminder = {
            id: crypto.randomUUID(),
            sessionID: context.sessionID,
            projectID: project.id,
            type: args.type,
            interval: args.interval_seconds * 1000,
            originalPrompt: args.action_prompt,
            userDescription: args.description,
            time: {
              created: Date.now(),
              nextExecution: Date.now() + args.interval_seconds * 1000,
            },
            status: "active",
          }

          state.reminders.set(reminder.id, reminder)
          await saveReminder(reminder, ctx)
          await scheduleTimer(reminder, ctx, state)

          console.log(`[RemindersPlugin] Created ${args.type} reminder ${reminder.id}: ${args.description}`)

          return `Reminder set: ${args.description} (${args.type === "one-time" ? "in" : "every"} ${args.interval_seconds} seconds)`
        },
      }),

      reminderlist: tool({
        description: REMINDERLIST_DESCRIPTION,

        args: {},

        async execute(_args, context) {
          const reminders = Array.from(state.reminders.values()).filter(
            (r) => r.sessionID === context.sessionID && r.status === "active",
          )

          if (reminders.length === 0) {
            return "No active reminders in this session."
          }

          const output = reminders
            .map((r) => {
              const nextIn = Math.round((r.time.nextExecution - Date.now()) / 1000)
              const nextText = nextIn > 0 ? `in ${nextIn}s` : "overdue"
              return `- ${r.userDescription} (${r.type}, next execution ${nextText})`
            })
            .join("\n")

          return `Active reminders:\n${output}`
        },
      }),

      reminderremove: tool({
        description: REMINDERREMOVE_DESCRIPTION,

        args: {
          description_pattern: tool.schema
            .string()
            .describe("What the user wants to stop (will match against reminder descriptions)"),
        },

        async execute(args, context) {
          const reminders = Array.from(state.reminders.values()).filter(
            (r) => r.sessionID === context.sessionID && r.status === "active",
          )

          const pattern = args.description_pattern.toLowerCase()
          const matches = reminders.filter(
            (r) =>
              r.userDescription.toLowerCase().includes(pattern) || r.originalPrompt.toLowerCase().includes(pattern),
          )

          if (matches.length === 0) {
            const activeList = reminders.map((r) => `- ${r.userDescription}`).join("\n") || "None"
            return `No matching reminder found for "${args.description_pattern}". Active reminders:\n${activeList}`
          }

          if (matches.length > 1) {
            const matchList = matches.map((r) => `- ${r.userDescription}`).join("\n")
            return `Multiple reminders match "${args.description_pattern}":\n${matchList}\nPlease be more specific.`
          }

          const reminder = matches[0]
          await cancelReminder(reminder.id, ctx, state)

          console.log(`[RemindersPlugin] Cancelled reminder ${reminder.id} via user request`)

          return `Reminder cancelled: ${reminder.userDescription}`
        },
      }),
    },
  }
}

export default RemindersPlugin
