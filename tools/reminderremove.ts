import { tool, type PluginInput } from "@opencode-ai/plugin"
import type { State } from "../types"
import { cancelReminder } from "../scheduler"
import DESCRIPTION from "./reminderremove.txt"
import { logger } from "../logger"

export function createReminderRemoveTool(ctx: PluginInput, state: State) {
  return tool({
    description: DESCRIPTION,

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

      logger.info(`[RemindersPlugin] Cancelled reminder ${reminder.id} via user request`)

      return `Reminder cancelled: ${reminder.userDescription}`
    },
  })
}
