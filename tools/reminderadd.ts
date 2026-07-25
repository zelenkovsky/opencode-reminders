import { tool, type PluginInput } from "@opencode-ai/plugin"
import type { Reminder, State, PluginConfig } from "../types"
import { scheduleTimer } from "../scheduler"
import DESCRIPTION from "./reminderadd.txt"
import { logger } from "../logger"

export function createReminderAddTool(
  ctx: PluginInput,
  state: State,
  getConfig: () => PluginConfig,
) {
  return tool({
    description: DESCRIPTION,

    args: {
      interval_seconds: tool.schema.number().min(30).describe("Time interval in seconds (minimum 30)"),
      type: tool.schema.enum(["one-time", "recurring"]).describe("Whether this reminder runs once or repeatedly"),
      action_prompt: tool.schema
        .string()
        .describe("Fully resolved action with absolute paths and specific identifiers"),
      description: tool.schema.string().describe("Human-readable description for identification"),
    },

    async execute(args, context) {
      const config = getConfig()
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
        projectID: ctx.project.id,
        type: args.type,
        interval: args.interval_seconds * 1000,
        originalPrompt: args.action_prompt,
        userDescription: args.description,
        agent: context.agent,
        time: {
          created: Date.now(),
          nextExecution: Date.now() + args.interval_seconds * 1000,
        },
        status: "active",
      }

      state.reminders.set(reminder.id, reminder)
      if (!(await scheduleTimer(reminder, ctx, state, config))) {
        return "Reminder scheduler reloaded while setting the reminder. Check active reminders before retrying."
      }

      logger.info(`[RemindersPlugin] Created ${args.type} reminder ${reminder.id}: ${args.description}`)

      return `Reminder set: ${args.description} (${args.type === "one-time" ? "in" : "every"} ${args.interval_seconds} seconds)`
    },
  })
}
