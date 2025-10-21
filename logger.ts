import { appendFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

const LOG_DIR = join(homedir(), ".local/share/opencode/log")
const LOG_FILE = join(LOG_DIR, "reminders.log")

enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  ERROR = 2,
}

const LOG_LEVEL_NAMES: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: "DEBUG",
  [LogLevel.INFO]: "INFO",
  [LogLevel.ERROR]: "ERROR",
}

function getCurrentLevel(): LogLevel {
  const env = process.env.REMINDERS_LOG_LEVEL?.toLowerCase()
  switch (env) {
    case "debug":
      return LogLevel.DEBUG
    case "info":
      return LogLevel.INFO
    case "error":
      return LogLevel.ERROR
    default:
      return LogLevel.INFO
  }
}

function writeLog(level: LogLevel, message: string, args: any[]): void {
  const currentLevel = getCurrentLevel()
  
  if (level < currentLevel) {
    return
  }

  const timestamp = new Date().toISOString()
  const levelName = LOG_LEVEL_NAMES[level]
  const formattedArgs = args.length > 0 
    ? ` ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}`
    : ""
  const formatted = `${timestamp} [${levelName}] ${message}${formattedArgs}\n`
  
  try {
    appendFileSync(LOG_FILE, formatted, "utf-8")
  } catch (error) {
  }
}

export const logger = {
  debug: (message: string, ...args: any[]): void => {
    writeLog(LogLevel.DEBUG, message, args)
  },
  info: (message: string, ...args: any[]): void => {
    writeLog(LogLevel.INFO, message, args)
  },
  error: (message: string, ...args: any[]): void => {
    writeLog(LogLevel.ERROR, message, args)
  },
}
