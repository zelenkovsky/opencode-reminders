import { tool } from "@opencode-ai/plugin"
import type { State } from "../types"
import DESCRIPTION from "./reminderlist.txt"

export function createReminderListTool(state: State) {
  return tool({
    description: DESCRIPTION,

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
  })
}
