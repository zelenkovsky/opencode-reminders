import type { PluginInput } from "@opencode-ai/plugin"
import type { Reminder, State } from "./types"
import { saveReminder, deleteReminder } from "./storage"

export async function scheduleTimer(reminder: Reminder, ctx: PluginInput, state: State): Promise<void> {
  const existingTimer = state.timers.get(reminder.id)
  if (existingTimer) {
    clearTimeout(existingTimer)
  }

  const now = Date.now()
  let delay = reminder.time.nextExecution - now

  // Handle missed execution windows for recurring reminders
  if (delay < 0 && reminder.type === "recurring") {
    // Calculate how many intervals were missed
    const missedIntervals = Math.ceil(Math.abs(delay) / reminder.interval)
    // Schedule for next interval from the original scheduled time to maintain cadence
    reminder.time.nextExecution = reminder.time.nextExecution + (missedIntervals * reminder.interval)
    delay = reminder.time.nextExecution - now
    await saveReminder(reminder, ctx)
    console.log(
      `[RemindersPlugin] Skipped ${missedIntervals} missed execution(s) for recurring reminder ${reminder.id}`,
    )
  } else {
    // For one-time reminders or on-time recurring, use the scheduled time
    delay = Math.max(0, delay)
  }

  const timer = setTimeout(async () => {
    state.timers.delete(reminder.id)
    await executeReminder(reminder, ctx, state)
  }, delay)

  // CRITICAL: Allow process to exit even with active timers
  timer.unref()

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
      state.reminders.set(reminder.id, reminder)
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
        state.reminders.set(reminder.id, reminder)
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
