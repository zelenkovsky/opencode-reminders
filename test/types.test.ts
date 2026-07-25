import { test, expect, describe } from "bun:test"
import { ReminderSchema } from "../types"

describe("Reminder Types", () => {
  test("ReminderSchema validates correct reminder", () => {
    const validReminder = {
      id: "test-123",
      sessionID: "ses-456",
      projectID: "prj-789",
      type: "one-time" as const,
      interval: 5000,
      originalPrompt: "check /workspace/test.txt",
      userDescription: "Test reminder",
      time: {
        created: Date.now(),
        nextExecution: Date.now() + 5000,
      },
      status: "active" as const,
    }

    expect(() => ReminderSchema.parse(validReminder)).not.toThrow()
  })

  test("ReminderSchema preserves an optional agent and accepts legacy omission", () => {
    const reminder = {
      id: "test-agent",
      sessionID: "ses-agent",
      projectID: "prj-agent",
      type: "one-time" as const,
      interval: 5000,
      originalPrompt: "test",
      userDescription: "Agent reminder",
      time: { created: Date.now(), nextExecution: Date.now() + 5000 },
      status: "active" as const,
    }

    expect(ReminderSchema.parse(reminder).agent).toBeUndefined()
    expect(ReminderSchema.parse({ ...reminder, agent: "build" }).agent).toBe("build")
  })

  test("ReminderSchema rejects invalid type", () => {
    const invalidReminder = {
      id: "test-123",
      sessionID: "ses-456",
      projectID: "prj-789",
      type: "invalid-type",
      interval: 5000,
      originalPrompt: "test",
      userDescription: "Test",
      time: {
        created: Date.now(),
        nextExecution: Date.now() + 5000,
      },
      status: "active",
    }

    expect(() => ReminderSchema.parse(invalidReminder)).toThrow()
  })

  test("ReminderSchema allows optional lastExecution", () => {
    const reminderWithLastExecution = {
      id: "test-123",
      sessionID: "ses-456",
      projectID: "prj-789",
      type: "recurring" as const,
      interval: 10000,
      originalPrompt: "test",
      userDescription: "Test",
      time: {
        created: Date.now(),
        nextExecution: Date.now() + 10000,
        lastExecution: Date.now() - 5000,
      },
      status: "active" as const,
    }

    expect(() => ReminderSchema.parse(reminderWithLastExecution)).not.toThrow()
  })

  test("ReminderSchema supports all reminder types", () => {
    expect(() =>
      ReminderSchema.parse({
        id: "1",
        sessionID: "s1",
        projectID: "p1",
        type: "one-time",
        interval: 1000,
        originalPrompt: "test",
        userDescription: "test",
        time: { created: 0, nextExecution: 0 },
        status: "active",
      }),
    ).not.toThrow()

    expect(() =>
      ReminderSchema.parse({
        id: "1",
        sessionID: "s1",
        projectID: "p1",
        type: "recurring",
        interval: 1000,
        originalPrompt: "test",
        userDescription: "test",
        time: { created: 0, nextExecution: 0 },
        status: "active",
      }),
    ).not.toThrow()
  })

  test("ReminderSchema supports all status types", () => {
    const statuses = ["active", "paused", "cancelled"] as const

    for (const status of statuses) {
      expect(() =>
        ReminderSchema.parse({
          id: "1",
          sessionID: "s1",
          projectID: "p1",
          type: "one-time",
          interval: 1000,
          originalPrompt: "test",
          userDescription: "test",
          time: { created: 0, nextExecution: 0 },
          status,
        }),
      ).not.toThrow()
    }
  })
})
