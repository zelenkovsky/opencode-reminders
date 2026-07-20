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

      // Cancel all matching reminders
      const cancelledDescriptions: string[] = []
      for (const reminder of matches) {
        if (await cancelReminder(reminder.id, ctx, state)) {
          cancelledDescriptions.push(reminder.userDescription)
          logger.info(`[RemindersPlugin] Cancelled reminder ${reminder.id} via user request`)
        }
      }

      if (cancelledDescriptions.length === 0) {
        return "Reminder scheduler reloaded while cancelling. Check active reminders before retrying."
      }
      if (cancelledDescriptions.length === 1) {
        return `Reminder cancelled: ${cancelledDescriptions[0]}`
      } else {
        const cancelledList = cancelledDescriptions.map((desc) => `- ${desc}`).join("\n")
        return `${cancelledDescriptions.length} reminders cancelled:\n${cancelledList}`
      }
    },
  })
}
