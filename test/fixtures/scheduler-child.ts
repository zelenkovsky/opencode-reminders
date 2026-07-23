import { appendFile } from "node:fs/promises"
import { $ } from "bun"
import type { PluginInput } from "@opencode-ai/plugin"
import { executeReminder } from "../../scheduler"
import type { PluginConfig, Reminder, State } from "../../types"

const [directory, reminderPath, recorder] = process.argv.slice(2)
if (!directory || !reminderPath || !recorder) throw new Error("missing scheduler child arguments")

const reminder = await Bun.file(reminderPath).json() as Reminder
const ctx: PluginInput = {
  client: {
    session: {
      prompt: async () => {
        await appendFile(recorder, "prompt\n")
        process.stdout.write("prompted\n")
        await new Response(Bun.stdin.stream()).text()
        return { data: {} as any, error: undefined, response: {} as any }
      },
    },
    tui: { showToast: async () => {} },
  } as any,
  project: { id: "lease-project", worktree: directory, time: { created: Date.now() } },
  directory,
  worktree: directory,
  $,
}
const state: State = { reminders: new Map([[reminder.id, reminder]]), timers: new Map(), projectID: "lease-project" }
const config: PluginConfig = {
  enabled: true,
  max_reminders_per_project: 50,
  min_interval_seconds: 30,
  notifications: { enabled: false },
}

await executeReminder(reminder, ctx, state, config)
process.stdout.write("finished\n")
