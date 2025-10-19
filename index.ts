import { Plugin, tool } from "@opencode-ai/plugin"
import type { Reminder, State } from "./types"
import { ReminderSchema } from "./types"
import { getStorageDir, saveReminder, deleteReminder, listReminders } from "./storage"
import { scheduleTimer, cancelReminder } from "./scheduler"

export const RemindersPlugin: Plugin = async (ctx) => {
  const { client, project } = ctx

  console.log(`[RemindersPlugin] Initializing for project ${project.id}`)

  await getStorageDir(ctx)

  const state: State = {
    reminders: new Map(),
    timers: new Map(),
    projectID: project.id,
  }

  const gracePeriod = 60 * 60 * 1000
  const now = Date.now()
  let restoredCount = 0
  let expiredCount = 0
  let invalidCount = 0

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
      restoredCount++
    } catch (error) {
      console.error(`[RemindersPlugin] Failed to restore reminder:`, error)
      if (reminder.id) {
        await deleteReminder(reminder.id, ctx)
      }
      invalidCount++
    }
  }

  console.log(
    `[RemindersPlugin] Restored ${restoredCount} reminders (${expiredCount} expired, ${invalidCount} invalid)`,
  )

  process.on("beforeExit", () => {
    console.log(`[RemindersPlugin] Cleaning up ${state.timers.size} timers`)
    for (const timer of state.timers.values()) {
      clearTimeout(timer)
    }
  })

  return {
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
        description: `Set up a reminder to re-execute an action later. Use when user asks to 'remind me to...' or 'check X every Y time'. Actually performs the action when triggered, not just notifies.

Parameters:
  - interval_seconds - Time between executions (minimum 30 seconds)
  - type - Either "one-time" or "recurring"
  - action_prompt - The action to perform when triggered (fully resolved with absolute paths)
  - description - Human-readable label for identifying this reminder

User Pattern Recognition:
  - "in 5 minutes do X" → one-time, 5min delay
  - "every hour do Y" → recurring, 1hr interval
  - "regularly check Z" → recurring, 1min default interval

CRITICAL - Action Prompt Requirements:
  - Must contain fully resolved information (absolute paths, specific names, concrete data)
  - Context may change over time, so avoid vague references
  - Include all necessary details for standalone execution

Examples:
  - "Wait for 5 min and check this file again for instructions" → Creates one-time reminder
  - "Check this website regularly and let me know when it has new information" → Sets recurring 1-minute timer
  - "Check my email every hour and reply that I'm busy" → Creates recurring 1-hour timer`,

        args: {
          interval_seconds: tool.schema.number().min(30).describe("Time interval in seconds (minimum 30)"),
          type: tool.schema.enum(["one-time", "recurring"]).describe("Whether this reminder runs once or repeatedly"),
          action_prompt: tool.schema
            .string()
            .describe("Fully resolved action with absolute paths and specific identifiers"),
          description: tool.schema.string().describe("Human-readable description for identification"),
        },

        async execute(args, context) {
          const maxReminders = 50
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
        description: `List all active reminders in this session. Use when user asks 'what reminders do I have' or wants to see scheduled actions.

Returns:
  - Array of active reminders with descriptions
  - Next execution time for each reminder
  - Reminder type (one-time or recurring)

Example Usage: "Show me what I'm waiting for"`,

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
        description: `Cancel a scheduled reminder. Use when user asks to 'stop checking X' or 'cancel the reminder for Y'. Matches user's description pattern to existing reminders.

Parameters:
  - description_pattern - Text pattern to match against reminder descriptions

Example Usage: "Stop checking my email"

Response Format:
  - Success: "Reminder cancelled: No longer checking your email every hour"
  - Error: "No matching reminder found" if pattern doesn't match any active reminders

Usage notes:
  - Pattern matching is flexible and attempts to find best match
  - Use reminderlist first to see available reminders if uncertain
  - Only removes reminders from current session`,

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
