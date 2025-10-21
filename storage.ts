import path from "path"
import type { PluginInput } from "@opencode-ai/plugin"
import type { Reminder } from "./types"
import { logger } from "./logger"

export async function getStorageDir(ctx: PluginInput): Promise<string> {
  const dir = path.join(ctx.directory, ".opencode", "reminders", ctx.project.id)
  await ctx.$`mkdir -p ${dir}`.quiet()
  await Bun.write(path.join(ctx.directory, ".opencode", "reminders", ".gitignore"), "*")
  return dir
}

export async function saveReminder(reminder: Reminder, ctx: PluginInput): Promise<void> {
  const dir = await getStorageDir(ctx)
  const filePath = path.join(dir, `${reminder.id}.json`)
  await Bun.write(filePath, JSON.stringify(reminder, null, 2))
}

export async function loadReminder(id: string, ctx: PluginInput): Promise<Reminder | null> {
  const dir = await getStorageDir(ctx)
  const filePath = path.join(dir, `${id}.json`)

  try {
    return await Bun.file(filePath).json()
  } catch {
    return null
  }
}

export async function deleteReminder(id: string, ctx: PluginInput): Promise<void> {
  const dir = await getStorageDir(ctx)
  const filePath = path.join(dir, `${id}.json`)
  await ctx.$`rm -f ${filePath}`.quiet()
}

export async function listReminders(ctx: PluginInput): Promise<Reminder[]> {
  const dir = await getStorageDir(ctx)
  const reminders: Reminder[] = []

  for await (const file of new Bun.Glob("*.json").scan({ cwd: dir, absolute: true })) {
    try {
      const reminder = await Bun.file(file).json()
      reminders.push(reminder)
    } catch (error) {
      logger.error(`Failed to load reminder from ${file}:`, error)
    }
  }

  return reminders
}
