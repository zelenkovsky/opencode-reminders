import { z } from "zod"

export const ReminderSchema = z.object({
  id: z.string(),
  sessionID: z.string(),
  projectID: z.string(),
  type: z.enum(["one-time", "recurring"]),
  interval: z.number(),
  originalPrompt: z.string(),
  userDescription: z.string(),
  time: z.object({
    created: z.number(),
    nextExecution: z.number(),
    lastExecution: z.number().optional(),
  }),
  status: z.enum(["active", "paused", "cancelled"]),
})

export type Reminder = z.infer<typeof ReminderSchema>

export type State = {
  reminders: Map<string, Reminder>
  timers: Map<string, NodeJS.Timeout>
  projectID: string
}

export type PluginConfig = {
  enabled: boolean
  max_reminders_per_project: number
  min_interval_seconds: number
  notifications: {
    enabled: boolean
  }
}
