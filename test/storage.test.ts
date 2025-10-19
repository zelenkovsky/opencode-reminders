import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import { saveReminder, loadReminder, deleteReminder, listReminders, getStorageDir } from "../storage"
import type { Reminder } from "../types"
import type { PluginInput } from "@opencode-ai/plugin"
import { $ } from "bun"

async function createMockContext(tmpDir: string): Promise<PluginInput> {
  return {
    client: {} as any,
    project: {
      id: "test-project-123",
      worktree: tmpDir,
      time: { created: Date.now() },
    },
    directory: tmpDir,
    worktree: tmpDir,
    $: $,
  }
}

describe("Storage", () => {
  let tmpDir: string
  let ctx: PluginInput

  beforeEach(async () => {
    tmpDir = await $`mktemp -d`.text().then((t) => t.trim())
    ctx = await createMockContext(tmpDir)
  })

  afterEach(async () => {
    await $`rm -rf ${tmpDir}`.quiet()
  })

  test("getStorageDir creates directory structure", async () => {
    const dir = await getStorageDir(ctx)
    expect(dir).toContain(".opencode/reminders")
    expect(dir).toContain("test-project-123")

    const exists = await $`test -d ${dir}`.nothrow().quiet()
    expect(exists.exitCode).toBe(0)
  })

  test("saveReminder writes JSON file", async () => {
    const reminder: Reminder = {
      id: "rem-123",
      sessionID: "ses-456",
      projectID: "test-project-123",
      type: "one-time",
      interval: 5000,
      originalPrompt: "test prompt",
      userDescription: "Test reminder",
      time: {
        created: Date.now(),
        nextExecution: Date.now() + 5000,
      },
      status: "active",
    }

    await saveReminder(reminder, ctx)

    const dir = await getStorageDir(ctx)
    const filePath = `${dir}/rem-123.json`
    const exists = await $`test -f ${filePath}`.nothrow().quiet()
    expect(exists.exitCode).toBe(0)

    const content = await Bun.file(filePath).json()
    expect(content).toEqual(reminder)
  })

  test("loadReminder reads existing file", async () => {
    const reminder: Reminder = {
      id: "rem-load-test",
      sessionID: "ses-456",
      projectID: "test-project-123",
      type: "recurring",
      interval: 10000,
      originalPrompt: "test load",
      userDescription: "Load test",
      time: {
        created: Date.now(),
        nextExecution: Date.now() + 10000,
      },
      status: "active",
    }

    await saveReminder(reminder, ctx)
    const loaded = await loadReminder("rem-load-test", ctx)

    expect(loaded).toEqual(reminder)
  })

  test("loadReminder returns null for non-existent file", async () => {
    const loaded = await loadReminder("non-existent", ctx)
    expect(loaded).toBeNull()
  })

  test("deleteReminder removes file", async () => {
    const reminder: Reminder = {
      id: "rem-delete-test",
      sessionID: "ses-456",
      projectID: "test-project-123",
      type: "one-time",
      interval: 5000,
      originalPrompt: "test delete",
      userDescription: "Delete test",
      time: {
        created: Date.now(),
        nextExecution: Date.now() + 5000,
      },
      status: "active",
    }

    await saveReminder(reminder, ctx)
    await deleteReminder("rem-delete-test", ctx)

    const loaded = await loadReminder("rem-delete-test", ctx)
    expect(loaded).toBeNull()
  })

  test("listReminders returns all reminders", async () => {
    const reminders: Reminder[] = [
      {
        id: "rem-1",
        sessionID: "ses-1",
        projectID: "test-project-123",
        type: "one-time",
        interval: 5000,
        originalPrompt: "test 1",
        userDescription: "Test 1",
        time: { created: Date.now(), nextExecution: Date.now() + 5000 },
        status: "active",
      },
      {
        id: "rem-2",
        sessionID: "ses-2",
        projectID: "test-project-123",
        type: "recurring",
        interval: 10000,
        originalPrompt: "test 2",
        userDescription: "Test 2",
        time: { created: Date.now(), nextExecution: Date.now() + 10000 },
        status: "active",
      },
    ]

    for (const reminder of reminders) {
      await saveReminder(reminder, ctx)
    }

    const loaded = await listReminders(ctx)
    expect(loaded).toHaveLength(2)
    expect(loaded.map((r) => r.id).sort()).toEqual(["rem-1", "rem-2"])
  })

  test("listReminders returns empty array when no reminders", async () => {
    const loaded = await listReminders(ctx)
    expect(loaded).toHaveLength(0)
  })

  test("listReminders skips corrupted files", async () => {
    const dir = await getStorageDir(ctx)
    await Bun.write(`${dir}/corrupted.json`, "invalid json {{{")

    const validReminder: Reminder = {
      id: "rem-valid",
      sessionID: "ses-1",
      projectID: "test-project-123",
      type: "one-time",
      interval: 5000,
      originalPrompt: "test",
      userDescription: "Valid",
      time: { created: Date.now(), nextExecution: Date.now() + 5000 },
      status: "active",
    }

    await saveReminder(validReminder, ctx)

    const loaded = await listReminders(ctx)
    expect(loaded).toHaveLength(1)
    expect(loaded[0].id).toBe("rem-valid")
  })
})
