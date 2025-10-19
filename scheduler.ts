import type { PluginInput } from "@opencode-ai/plugin"
import type { Reminder, State } from "./types"
import { saveReminder, deleteReminder } from "./storage"

export async function scheduleTimer(reminder: Reminder, ctx: PluginInput, state: State): Promise<void> {
  const existingTimer = state.timers.get(reminder.id)
  if (existingTimer) {
    clearTimeout(existingTimer)
  }

  const delay = Math.max(0, reminder.time.nextExecution - Date.now())

  const timer = setTimeout(async () => {
    state.timers.delete(reminder.id)
    await executeReminder(reminder, ctx, state)
  }, delay)

  state.timers.set(reminder.id, timer)

  console.log(`Scheduled reminder ${reminder.id} to execute in ${Math.round(delay / 1000)}s`)
}

export async function executeReminder(reminder: Reminder, ctx: PluginInput, state: State): Promise<void> {
  console.log(`Executing reminder ${reminder.id}: ${reminder.userDescription}`)

  try {
    await ctx.client.session.prompt({
      path: { id: reminder.sessionID },
      body: {
        parts: [
          {
            type: "text",
            text: reminder.originalPrompt,
          },
        ],
      },
    })

    reminder.time.lastExecution = Date.now()

    if (reminder.type === "recurring") {
      reminder.time.nextExecution = Date.now() + reminder.interval
      await saveReminder(reminder, ctx)
      await scheduleTimer(reminder, ctx, state)
      console.log(`Recurring reminder ${reminder.id} rescheduled`)
    } else {
      await cancelReminder(reminder.id, ctx, state)
      console.log(`One-time reminder ${reminder.id} completed and removed`)
    }
  } catch (error: any) {
    console.error(`Reminder ${reminder.id} execution failed:`, error)

    if (error?.name === "MessageAbortedError") {
      if (reminder.type === "recurring") {
        reminder.time.nextExecution = Date.now() + reminder.interval
        await saveReminder(reminder, ctx)
        await scheduleTimer(reminder, ctx, state)
        console.log(`Recurring reminder ${reminder.id} rescheduled after abort`)
      } else {
        await cancelReminder(reminder.id, ctx, state)
        console.log(`One-time reminder ${reminder.id} cancelled after abort`)
      }
    } else {
      await cancelReminder(reminder.id, ctx, state)
      console.log(`Reminder ${reminder.id} cancelled due to error`)
    }
  }
}

export async function cancelReminder(id: string, ctx: PluginInput, state: State): Promise<void> {
  const timer = state.timers.get(id)
  if (timer) {
    clearTimeout(timer)
    state.timers.delete(id)
  }

  state.reminders.delete(id)

  await deleteReminder(id, ctx)

  console.log(`Reminder ${id} cancelled`)
}
