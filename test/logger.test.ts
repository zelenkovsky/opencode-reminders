import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import { $ } from "bun"
import { join } from "node:path"
import { homedir } from "node:os"

const LOG_DIR = join(homedir(), ".local/share/opencode/log")
const LOG_FILE = join(LOG_DIR, "reminders.log")

describe("Logger Tests", () => {
  let originalLogLevel: string | undefined

  beforeEach(async () => {
    originalLogLevel = process.env.REMINDERS_LOG_LEVEL
    await $`rm -f ${LOG_FILE}`.quiet()
  })

  afterEach(() => {
    if (originalLogLevel === undefined) {
      delete process.env.REMINDERS_LOG_LEVEL
    } else {
      process.env.REMINDERS_LOG_LEVEL = originalLogLevel
    }
  })

  test("should write debug messages when level is DEBUG", async () => {
    process.env.REMINDERS_LOG_LEVEL = "debug"
    
    delete require.cache[require.resolve("../logger.ts")]
    const { logger } = await import("../logger")
    
    await logger.debug("Test debug message")
    
    const content = await Bun.file(LOG_FILE).text()
    expect(content).toContain("[DEBUG] Test debug message")
  })

  test("should write info messages when level is INFO", async () => {
    process.env.REMINDERS_LOG_LEVEL = "info"
    
    delete require.cache[require.resolve("../logger.ts")]
    const { logger } = await import("../logger")
    
    await logger.info("Test info message")
    
    const content = await Bun.file(LOG_FILE).text()
    expect(content).toContain("[INFO] Test info message")
  })

  test("should write error messages when level is ERROR", async () => {
    process.env.REMINDERS_LOG_LEVEL = "error"
    
    delete require.cache[require.resolve("../logger.ts")]
    const { logger } = await import("../logger")
    
    await logger.error("Test error message")
    
    const content = await Bun.file(LOG_FILE).text()
    expect(content).toContain("[ERROR] Test error message")
  })

  test("should filter debug when level is INFO", async () => {
    process.env.REMINDERS_LOG_LEVEL = "info"
    
    delete require.cache[require.resolve("../logger.ts")]
    const { logger } = await import("../logger")
    
    await logger.debug("Should not appear")
    await logger.info("Should appear")
    
    const content = await Bun.file(LOG_FILE).text()
    expect(content).not.toContain("[DEBUG]")
    expect(content).toContain("[INFO] Should appear")
  })

  test("should filter debug and info when level is ERROR", async () => {
    process.env.REMINDERS_LOG_LEVEL = "error"
    
    delete require.cache[require.resolve("../logger.ts")]
    const { logger } = await import("../logger")
    
    await logger.debug("Should not appear")
    await logger.info("Should not appear")
    await logger.error("Should appear")
    
    const content = await Bun.file(LOG_FILE).text()
    expect(content).not.toContain("[DEBUG]")
    expect(content).not.toContain("[INFO]")
    expect(content).toContain("[ERROR] Should appear")
  })

  test("should default to INFO level", async () => {
    delete process.env.REMINDERS_LOG_LEVEL
    
    delete require.cache[require.resolve("../logger.ts")]
    const { logger } = await import("../logger")
    
    await logger.debug("Should not appear")
    await logger.info("Should appear")
    
    const content = await Bun.file(LOG_FILE).text()
    expect(content).not.toContain("[DEBUG]")
    expect(content).toContain("[INFO] Should appear")
  })

  test("should format messages with timestamp and level prefix", async () => {
    process.env.REMINDERS_LOG_LEVEL = "info"
    
    delete require.cache[require.resolve("../logger.ts")]
    const { logger } = await import("../logger")
    
    await logger.info("Test message")
    
    const content = await Bun.file(LOG_FILE).text()
    expect(content).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[INFO\] Test message/)
  })

  test("should handle multiple arguments", async () => {
    process.env.REMINDERS_LOG_LEVEL = "info"
    
    delete require.cache[require.resolve("../logger.ts")]
    const { logger } = await import("../logger")
    
    await logger.info("Message with", "multiple", "arguments")
    
    const content = await Bun.file(LOG_FILE).text()
    expect(content).toContain("[INFO] Message with multiple arguments")
  })

  test("should handle object arguments with JSON.stringify", async () => {
    process.env.REMINDERS_LOG_LEVEL = "info"
    
    delete require.cache[require.resolve("../logger.ts")]
    const { logger } = await import("../logger")
    
    await logger.info("Object:", { foo: "bar", num: 42 })
    
    const content = await Bun.file(LOG_FILE).text()
    expect(content).toContain('[INFO] Object: {"foo":"bar","num":42}')
  })

  test("should create log file if it doesn't exist", async () => {
    process.env.REMINDERS_LOG_LEVEL = "info"
    
    await $`rm -f ${LOG_FILE}`.quiet()
    
    delete require.cache[require.resolve("../logger.ts")]
    const { logger } = await import("../logger")
    
    await logger.info("First message")
    
    const exists = await Bun.file(LOG_FILE).exists()
    expect(exists).toBe(true)
  })

  test("should append to existing log file", async () => {
    process.env.REMINDERS_LOG_LEVEL = "info"
    
    delete require.cache[require.resolve("../logger.ts")]
    const { logger } = await import("../logger")
    
    await logger.info("First message")
    await logger.info("Second message")
    
    const content = await Bun.file(LOG_FILE).text()
    const lines = content.trim().split("\n")
    expect(lines.length).toBe(2)
    expect(lines[0]).toContain("[INFO] First message")
    expect(lines[1]).toContain("[INFO] Second message")
  })
})
