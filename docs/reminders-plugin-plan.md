# Reminders Feature → Plugin Migration Plan

**Status:** Research Complete - Ready for Implementation  
**Migration Type:** Built-in Feature → External Plugin  
**Target:** Separate npm package or local plugin  
**Feasibility:** ✅ CONFIRMED - All blockers resolved

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Research Findings](#research-findings)
3. [Blocker Resolutions](#blocker-resolutions)
4. [Migration Architecture](#migration-architecture)
5. [Implementation Plan](#implementation-plan)
6. [Testing Strategy](#testing-strategy)
7. [Trade-offs & Limitations](#trade-offs--limitations)
8. [Reference Implementation](#reference-implementation)

---

## Executive Summary

### Current State (Built-in Feature)

**Location:** `packages/opencode/src/reminder/`

**Files:**

- `manager.ts` (282 lines) - Core manager with timer persistence
- `reminder.ts` (23 lines) - Zod schema definitions
- `packages/opencode/src/tool/reminderadd.ts` (60 lines)
- `packages/opencode/src/tool/reminderlist.ts` (37 lines)
- `packages/opencode/src/tool/reminderremove.ts` (47 lines)
- `packages/opencode/src/tool/*.txt` - Tool descriptions

**Dependencies:**

- `Storage` API for persistence
- `Instance.state()` for project-scoped state
- `Bus.subscribe()` for event handling
- `SessionPrompt.prompt()` for reminder execution
- `Identifier.ascending()` for ID generation
- `Config.get()` for configuration
- `Flag.OPENCODE_DISABLE_REMINDERS` for feature toggle

### Target State (External Plugin)

**Location:** External package or `.opencode/plugin/reminders.ts`

**Distribution Options:**

1. **npm package:** `opencode-reminders@1.0.0`
2. **Local plugin:** `.opencode/plugin/reminders.ts`
3. **Global plugin:** `~/.config/opencode/plugin/reminders.ts`

**Why Migrate:**

- ✅ Decouple from core OpenCode repository
- ✅ Allow external maintenance and updates
- ✅ Enable user opt-in/opt-out via plugin system
- ✅ Serve as reference implementation for complex plugins
- ✅ Reduce core codebase size

---

## Research Findings

### SDK & Plugin API Capabilities

#### ✅ Available via Plugin API

**Plugin Input (`PluginInput`):**

```typescript
export type PluginInput = {
  client: ReturnType<typeof createOpencodeClient> // Full SDK client
  project: Project // Project metadata
  directory: string // Project directory
  worktree: string // Git worktree path
  $: BunShell // Bun shell for commands
}
```

**Plugin Hooks (`Hooks`):**

```typescript
export interface Hooks {
  event?: (input: { event: Event }) => Promise<void>
  config?: (input: Config) => Promise<void>
  tool?: { [key: string]: ToolDefinition }
  "chat.message"?: (input: {}, output: { message: UserMessage; parts: Part[] }) => Promise<void>
  "chat.params"?: (input: {...}, output: {...}) => Promise<void>
  "permission.ask"?: (input: Permission, output: { status: "ask" | "deny" | "allow" }) => Promise<void>
  "tool.execute.before"?: (input: {...}, output: {...}) => Promise<void>
  "tool.execute.after"?: (input: {...}, output: {...}) => Promise<void>
}
```

**SDK Client Methods (Relevant):**

```typescript
client.session.prompt({ path: { id }, body: { parts, model? } })
client.session.get({ path: { id } })
client.session.list()
client.event.subscribe()  // SSE stream
client.config.get()
```

**Event Types (Available):**

```typescript
type Event =
  | EventSessionDeleted // ← Critical for cleanup!
  | EventSessionUpdated
  | EventMessageUpdated
  | EventPermissionUpdated
  | EventFileEdited
  | EventTodoUpdated
  | EventSessionIdle
  | EventSessionCompacted
  | EventSessionError
// ... more
```

#### ❌ NOT Available in Plugin API

**Internal APIs (No SDK Equivalent):**

- `Storage` API (`Storage.write()`, `Storage.read()`, `Storage.list()`)
- `Instance.state()` for automatic state management
- `Bus.subscribe()` for internal event bus
- `Identifier.ascending()` for ID generation
- `Permission.RejectedError` specific error type
- `Log` service for structured logging

---

## Blocker Resolutions

### BLOCKER #1: Storage API

**Problem:** SDK does not expose `Storage` API used by current implementation

**Current Code:**

```typescript
// packages/opencode/src/reminder/manager.ts
import { Storage } from "../storage/storage"

await Storage.write(["reminder", Instance.project.id, reminder.id], reminder)
await Storage.read<Reminder.Info>(key)
await Storage.remove(key)
await Storage.list(["reminder", Instance.project.id])
```

**Resolution:** Use filesystem storage via Bun APIs

**Implementation:**

```typescript
// Plugin approach
const storageDir = path.join(ctx.directory, ".opencode-reminders", ctx.project.id)

// Write
await Bun.write(path.join(storageDir, `${reminder.id}.json`), JSON.stringify(reminder, null, 2))

// Read
const reminder = await Bun.file(path.join(storageDir, `${reminderID}.json`)).json()

// List
const files = await Array.fromAsync(new Bun.Glob("*.json").scan({ cwd: storageDir, absolute: true }))

// Remove
await Bun.$`rm -f ${path.join(storageDir, `${reminderID}.json`)}`.quiet()
// or
await fs.unlink(path.join(storageDir, `${reminderID}.json`))
```

**Storage Structure:**

```
.opencode-reminders/
  prj_abc123/              # Project ID
    rem_xyz789.json        # Reminder file
    rem_abc456.json
  prj_def456/
    rem_ghi789.json
```

**Advantages:**

- ✅ Simple JSON files (human-readable)
- ✅ Easy to debug and inspect
- ✅ No dependency on internal Storage API
- ✅ Can use `.gitignore` to exclude from version control

**Considerations:**

- ⚠️ Not integrated with OpenCode's storage migration system
- ⚠️ Plugin responsible for data format versioning
- ⚠️ Need to handle concurrent writes (use locks if needed)

---

### BLOCKER #2: Session Prompt Injection

**Problem:** Need to send reminder prompts without specifying model

**Current Code:**

```typescript
// packages/opencode/src/reminder/manager.ts
import { SessionPrompt } from "../session/prompt"

await SessionPrompt.prompt({
  sessionID: reminder.sessionID,
  messageID: Identifier.ascending("message"),
  parts: [
    {
      id: Identifier.ascending("part"),
      type: "text",
      text: reminder.originalPrompt,
    },
  ],
})
```

**Resolution:** ✅ Model parameter is OPTIONAL in SDK

**SDK Type Definition:**

```typescript
// packages/sdk/js/src/gen/types.gen.ts
export type SessionPromptData = {
  body?: {
    messageID?: string
    model?: {
      // ← OPTIONAL!
      providerID: string
      modelID: string
    }
    agent?: string
    parts: Array<TextPartInput | FilePartInput | AgentPartInput>
  }
  path: { id: string }
}
```

**Implementation:**

```typescript
// Plugin approach - omit model parameter
await client.session.prompt({
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
```

**Behavior:**

- ✅ Session will use its current model configuration
- ✅ No need to track or store model info in reminders
- ✅ Respects user's current session settings

**messageID Handling:**

- SDK auto-generates messageID if not provided
- Plugin can omit `messageID` field entirely
- If needed, use custom ID: `messageID: crypto.randomUUID()`

---

### BLOCKER #3: Event Subscription

**Problem:** Need to listen for session deletion to clean up reminders

**Current Code:**

```typescript
// packages/opencode/src/reminder/manager.ts
import { Bus } from "../bus"
import { Session } from "../session"

Bus.subscribe(Session.Event.Deleted, async ({ properties }) => {
  await cleanupSession(properties.info.id)
})
```

**Resolution:** ✅ `EventSessionDeleted` is available via plugin event hook

**SDK Event Type:**

```typescript
// packages/sdk/js/src/gen/types.gen.ts:1174
export type EventSessionDeleted = {
  type: "session.deleted"
  properties: {
    info: Session
  }
}

export type Session = {
  id: string
  projectID: string
  directory: string
  parentID?: string
  title: string
  // ... more fields
}
```

**Implementation:**

```typescript
// Plugin approach
export const RemindersPlugin: Plugin = async (ctx) => {
  const state = { reminders: new Map(), timers: new Map() }

  return {
    async event({ event }) {
      // Filter for session deletion events
      if (event.type === "session.deleted") {
        const sessionID = event.properties.info.id

        // Clean up all reminders for this session
        const reminders = Array.from(state.reminders.values()).filter((r) => r.sessionID === sessionID)

        for (const reminder of reminders) {
          await cancelReminder(reminder.id, state)
        }
      }
    },
  }
}
```

**Available Events for Future Use:**

- `session.updated` - Track session changes
- `session.idle` - Pause reminders when idle?
- `session.compacted` - Verify reminder messages weren't lost
- `message.updated` - Track reminder execution status

---

### BLOCKER #4: Instance State Management

**Problem:** Current implementation uses `Instance.state()` for automatic project-scoped state

**Current Code:**

```typescript
// packages/opencode/src/reminder/manager.ts
import { Instance } from "../project/instance"

const state = Instance.state(
  () => ({
    reminders: new Map<string, Reminder.Info>(),
    timers: new Map<string, NodeJS.Timeout>(),
  }),
  async (state) => {
    // Cleanup all timers on disposal
    for (const timer of state.timers.values()) {
      clearTimeout(timer)
    }
  },
)
```

**Resolution:** Plugins are initialized per-project, use closure-based state

**How Plugins Initialize:**

```typescript
// From packages/opencode/src/plugin/index.ts:14
const state = Instance.state(async () => {
  const input: PluginInput = {
    client,
    project: Instance.project, // ← Project-specific!
    worktree: Instance.worktree,
    directory: Instance.directory,
    $: Bun.$,
  }

  for (let plugin of plugins) {
    const mod = await import(plugin)
    for (const [_name, fn] of Object.entries<PluginInstance>(mod)) {
      const init = await fn(input) // ← Called once per project
      hooks.push(init)
    }
  }
})
```

**Implementation:**

```typescript
// Plugin approach - state in closure
export const RemindersPlugin: Plugin = async (ctx) => {
  // This state is scoped to THIS plugin instance
  // Each project gets its own instance
  const state = {
    reminders: new Map<string, Reminder>(),
    timers: new Map<string, NodeJS.Timeout>(),
    projectID: ctx.project.id,
  }

  // Initialize state from storage
  await restoreFromStorage(ctx, state)

  // Return hooks that close over state
  return {
    async event({ event }) {
      // Uses state from closure
    },
    tool: {
      reminderadd: tool({
        async execute(args, context) {
          // Uses state from closure
        },
      }),
    },
  }
}
```

**Cleanup Handling:**

Since there's no automatic disposal hook, handle cleanup via:

**Option 1: Process exit handlers**

```typescript
export const RemindersPlugin: Plugin = async (ctx) => {
  const state = {
    /* ... */
  }

  // Clean up on process exit
  process.on("beforeExit", () => {
    for (const timer of state.timers.values()) {
      clearTimeout(timer)
    }
  })

  return {
    /* ... */
  }
}
```

**Option 2: Event-based cleanup**

```typescript
// Clean up when project changes
async event({ event }) {
  if (event.type === "project.changed") {
    for (const timer of state.timers.values()) {
      clearTimeout(timer)
    }
  }
}
```

**Note:** In practice, timers will be cleaned up when Node.js process exits, so explicit cleanup is optional but recommended for clean shutdown.

---

### BLOCKER #5: Identifier Generation

**Problem:** Current implementation uses internal `Identifier.ascending()` API

**Current Code:**

```typescript
// packages/opencode/src/reminder/manager.ts
import { Identifier } from "../id/id"

const reminder: Reminder.Info = {
  id: Identifier.ascending("reminder"), // Generates: "rem_<timestamp>_<counter>"
  // ...
}
```

**Resolution:** Use standard UUID or custom ID scheme

**Implementation Options:**

**Option 1: UUID (Recommended)**

```typescript
// Built-in Node.js crypto
const reminderID = crypto.randomUUID()
// Example: "550e8400-e29b-41d4-a716-446655440000"
```

**Option 2: NanoID**

```typescript
// Requires: import { nanoid } from 'nanoid'
const reminderID = nanoid()
// Example: "V1StGXR8_Z5jdHi6B-myT"
```

**Option 3: Custom Ascending IDs (Compatible with original)**

```typescript
// Mimic Identifier.ascending() behavior
let counter = 0
function generateID(prefix: string): string {
  return `${prefix}_${Date.now()}_${counter++}`
}

const reminderID = generateID("rem")
// Example: "rem_1730970123456_0"
```

**Recommendation:** Use `crypto.randomUUID()` for simplicity

- ✅ No external dependencies
- ✅ Guaranteed uniqueness
- ✅ Standard format
- ✅ Built into Node.js/Bun

**For Part IDs:**

```typescript
// Original used Identifier.ascending("part")
// Plugin equivalent:
const partID = crypto.randomUUID()

// Or if you need the "prt_" prefix:
const partID = `prt_${crypto.randomUUID()}`
```

---

### BLOCKER #6: Permission Handling

**Problem:** Internal API has specific `Permission.RejectedError` type

**Current Code:**

```typescript
// packages/opencode/src/reminder/manager.ts
import { Permission } from "../permission"

try {
  await SessionPrompt.prompt({ ... })
} catch (error) {
  if (error instanceof Permission.RejectedError) {
    // Handle permission denial
    if (reminder.type === "recurring") {
      // Reschedule
    } else {
      // Cancel
    }
  }
}
```

**Resolution:** SDK uses different error types, check error names

**SDK Error Types:**

```typescript
// packages/sdk/js/src/gen/types.gen.ts
export type ProviderAuthError = {
  name: "ProviderAuthError"
  data: { providerID: string; message: string }
}

export type MessageAbortedError = {
  name: "MessageAbortedError"
  data: { message: string }
}

export type UnknownError = {
  name: "UnknownError"
  data: { message: string }
}

// Session errors can be:
type SessionPromptError = BadRequestError | NotFoundError
```

**Implementation:**

```typescript
// Plugin approach
async function executeReminder(reminder: Reminder, ctx: PluginInput, state: State) {
  try {
    await ctx.client.session.prompt({
      path: { id: reminder.sessionID },
      body: { parts: [{ type: "text", text: reminder.originalPrompt }] },
    })

    reminder.time.lastExecution = Date.now()
    await saveReminder(reminder, ctx)

    if (reminder.type === "recurring") {
      reminder.time.nextExecution = Date.now() + reminder.interval
      await scheduleTimer(reminder, ctx, state)
    } else {
      await cancelReminder(reminder.id, ctx, state)
    }
  } catch (error: any) {
    console.error(`Reminder ${reminder.id} execution failed:`, error)

    // Check error type
    if (error?.name === "MessageAbortedError") {
      // User aborted - possibly permission denial
      if (reminder.type === "recurring") {
        // Reschedule recurring reminders
        reminder.time.nextExecution = Date.now() + reminder.interval
        await saveReminder(reminder, ctx)
        await scheduleTimer(reminder, ctx, state)
      } else {
        // Cancel one-time reminders
        await cancelReminder(reminder.id, ctx, state)
      }
    } else if (error?.name === "NotFoundError") {
      // Session deleted - clean up
      await cancelReminder(reminder.id, ctx, state)
    } else {
      // Unknown error - cancel to be safe
      await cancelReminder(reminder.id, ctx, state)
    }
  }
}
```

**Error Handling Strategy:**

1. **MessageAbortedError** → Likely permission denial, reschedule recurring
2. **NotFoundError** → Session deleted, cancel reminder
3. **ProviderAuthError** → Auth issue, cancel reminder
4. **UnknownError** → Generic error, cancel reminder
5. **Success** → Update execution time, schedule next (if recurring)

---

### BLOCKER #7: Bootstrap Integration

**Problem:** Need to restore reminders from storage on startup

**Current Code:**

```typescript
// packages/opencode/src/reminder/manager.ts
export function init() {
  log.info("init")

  // Restore from storage asynchronously
  Storage.list(["reminder", Instance.project.id]).then(async (reminderKeys) => {
    const config = await Config.get()
    if (config.reminders?.enabled === false) {
      return
    }

    for (const key of reminderKeys) {
      const reminder = await Storage.read<Reminder.Info>(key)
      // Validate session, schedule timer, etc.
    }
  })
}

// Called from packages/opencode/src/project/bootstrap.ts
ReminderManager.init()
```

**Resolution:** Initialize in plugin function, which is called after project bootstrap

**Plugin Lifecycle:**

```typescript
// packages/opencode/src/plugin/index.ts
export async function init() {
  const hooks = await state().then((x) => x.hooks)
  const config = await Config.get()

  // Config hook called first
  for (const hook of hooks) {
    await hook.config?.(config)
  }

  // Event subscription setup
  Bus.subscribeAll(async (input) => {
    for (const hook of hooks) {
      hook["event"]?.({ event: input })
    }
  })
}
```

**Implementation:**

```typescript
// Plugin approach - restore in plugin function
export const RemindersPlugin: Plugin = async (ctx) => {
  const { client, project, directory } = ctx
  const storageDir = path.join(directory, ".opencode-reminders", project.id)

  const state = {
    reminders: new Map<string, Reminder>(),
    timers: new Map<string, NodeJS.Timeout>(),
  }

  // Ensure storage directory exists
  await Bun.$`mkdir -p ${storageDir}`.quiet()

  // Restore reminders from storage
  const gracePeriod = 60 * 60 * 1000 // 1 hour
  const now = Date.now()

  for await (const file of new Bun.Glob("*.json").scan({ cwd: storageDir, absolute: true })) {
    try {
      const reminder = (await Bun.file(file).json()) as Reminder

      // Validate session still exists
      try {
        await client.session.get({ path: { id: reminder.sessionID } })
      } catch {
        // Session deleted, remove reminder
        await Bun.$`rm -f ${file}`.quiet()
        continue
      }

      // Check if reminder is not too expired
      if (reminder.time.nextExecution + gracePeriod < now) {
        // Too old, remove
        await Bun.$`rm -f ${file}`.quiet()
        continue
      }

      // Valid reminder - restore
      state.reminders.set(reminder.id, reminder)
      await scheduleTimer(reminder, ctx, state)
    } catch (error) {
      console.error(`Failed to restore reminder from ${file}:`, error)
      // Optionally delete corrupted file
      await Bun.$`rm -f ${file}`.quiet()
    }
  }

  console.log(`Restored ${state.reminders.size} reminders for project ${project.id}`)

  return {
    // event hook, tools, etc.
  }
}
```

**Validation Steps During Restore:**

1. ✅ Read JSON file
2. ✅ Verify session exists (via SDK)
3. ✅ Check expiration (nextExecution + grace period)
4. ✅ Schedule timer
5. ✅ Handle corrupted/invalid files

**Safe to Run:**

- Plugin initialization happens AFTER project bootstrap
- Config is available via `config` hook
- SDK client is fully initialized
- Can make async calls to validate state

---

## Migration Architecture

### Directory Structure

**Option 1: npm Package**

```
opencode-reminders/
  src/
    index.ts           # Main plugin export
    types.ts           # Reminder types
    storage.ts         # Storage helpers
    scheduler.ts       # Timer management
    tools/
      add.ts          # reminderadd tool
      list.ts         # reminderlist tool
      remove.ts       # reminderremove tool
  package.json
  tsconfig.json
  README.md
```

**Option 2: Local Plugin**

```
.opencode/
  plugin/
    reminders.ts      # All-in-one plugin file
```

**Option 3: Global Plugin**

```
~/.config/opencode/
  plugin/
    reminders.ts
```

### Data Model

**Reminder Type (Maintained from Original):**

```typescript
type Reminder = {
  id: string // crypto.randomUUID()
  sessionID: string // From tool context
  projectID: string // From PluginInput.project.id
  type: "one-time" | "recurring"
  interval: number // milliseconds
  originalPrompt: string // Resolved action
  userDescription: string // Human-readable label
  time: {
    created: number // Date.now()
    nextExecution: number // When to execute
    lastExecution?: number // When last executed
  }
  status: "active" | "paused" | "cancelled"
}
```

**Storage Format:**

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "sessionID": "ses_1234567890_0",
  "projectID": "abc123def456",
  "type": "recurring",
  "interval": 300000,
  "originalPrompt": "Check /workspace/status.log for new entries and report changes",
  "userDescription": "Check status log every 5 minutes",
  "time": {
    "created": 1730970000000,
    "nextExecution": 1730970300000,
    "lastExecution": 1730970000000
  },
  "status": "active"
}
```

### State Management

```typescript
type State = {
  reminders: Map<string, Reminder> // In-memory cache
  timers: Map<string, NodeJS.Timeout> // Active timers
  projectID: string // For validation
}
```

**State Operations:**

- `saveReminder()` - Write to disk + update map
- `loadReminder()` - Read from disk
- `cancelReminder()` - Clear timer + delete file + remove from map
- `scheduleTimer()` - Create setTimeout + store in map
- `restoreFromStorage()` - Load all reminders on init

---

## Implementation Plan

### Phase 1: Setup (1-2 hours)

**1.1 Create Plugin Package Structure**

```bash
mkdir -p opencode-reminders/src/tools
cd opencode-reminders
bun init -y
```

**1.2 Install Dependencies**

```json
{
  "name": "opencode-reminders",
  "version": "1.0.0",
  "type": "module",
  "dependencies": {
    "@opencode-ai/plugin": "workspace:*",
    "@opencode-ai/sdk": "workspace:*",
    "zod": "^3.22.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "typescript": "^5.0.0"
  },
  "exports": {
    ".": "./src/index.ts"
  }
}
```

**1.3 TypeScript Configuration**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*"]
}
```

### Phase 2: Core Implementation (4-6 hours)

**2.1 Define Types (`src/types.ts`)**

```typescript
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
```

**2.2 Storage Module (`src/storage.ts`)**

```typescript
import path from "path"
import type { PluginInput } from "@opencode-ai/plugin"
import type { Reminder } from "./types"

export async function getStorageDir(ctx: PluginInput): Promise<string> {
  const dir = path.join(ctx.directory, ".opencode-reminders", ctx.project.id)
  await Bun.$`mkdir -p ${dir}`.quiet()
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
  await Bun.$`rm -f ${filePath}`.quiet()
}

export async function listReminders(ctx: PluginInput): Promise<Reminder[]> {
  const dir = await getStorageDir(ctx)
  const reminders: Reminder[] = []

  for await (const file of new Bun.Glob("*.json").scan({ cwd: dir, absolute: true })) {
    try {
      const reminder = await Bun.file(file).json()
      reminders.push(reminder)
    } catch (error) {
      console.error(`Failed to load reminder from ${file}:`, error)
    }
  }

  return reminders
}
```

**2.3 Scheduler Module (`src/scheduler.ts`)**

```typescript
import type { PluginInput } from "@opencode-ai/plugin"
import type { Reminder, State } from "./types"
import { saveReminder, deleteReminder } from "./storage"

export async function scheduleTimer(reminder: Reminder, ctx: PluginInput, state: State): Promise<void> {
  // Clear existing timer if any
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

    // Update last execution time
    reminder.time.lastExecution = Date.now()

    if (reminder.type === "recurring") {
      // Schedule next execution
      reminder.time.nextExecution = Date.now() + reminder.interval
      await saveReminder(reminder, ctx)
      await scheduleTimer(reminder, ctx, state)
      console.log(`Recurring reminder ${reminder.id} rescheduled`)
    } else {
      // Remove one-time reminder
      await cancelReminder(reminder.id, ctx, state)
      console.log(`One-time reminder ${reminder.id} completed and removed`)
    }
  } catch (error: any) {
    console.error(`Reminder ${reminder.id} execution failed:`, error)

    if (error?.name === "MessageAbortedError") {
      // Permission denied or user aborted
      if (reminder.type === "recurring") {
        // Reschedule recurring reminders
        reminder.time.nextExecution = Date.now() + reminder.interval
        await saveReminder(reminder, ctx)
        await scheduleTimer(reminder, ctx, state)
        console.log(`Recurring reminder ${reminder.id} rescheduled after abort`)
      } else {
        // Cancel one-time reminders
        await cancelReminder(reminder.id, ctx, state)
        console.log(`One-time reminder ${reminder.id} cancelled after abort`)
      }
    } else {
      // Other errors - cancel reminder
      await cancelReminder(reminder.id, ctx, state)
      console.log(`Reminder ${reminder.id} cancelled due to error`)
    }
  }
}

export async function cancelReminder(id: string, ctx: PluginInput, state: State): Promise<void> {
  // Clear timer
  const timer = state.timers.get(id)
  if (timer) {
    clearTimeout(timer)
    state.timers.delete(id)
  }

  // Remove from state
  state.reminders.delete(id)

  // Delete from storage
  await deleteReminder(id, ctx)

  console.log(`Reminder ${id} cancelled`)
}
```

**2.4 Tools (`src/tools/add.ts`, `list.ts`, `remove.ts`)**

See [Reference Implementation](#reference-implementation) section below for complete tool implementations.

**2.5 Main Plugin (`src/index.ts`)**

See [Reference Implementation](#reference-implementation) section below for complete plugin implementation.

### Phase 3: Testing (2-3 hours)

**3.1 Unit Tests**

- Test storage operations (save, load, delete, list)
- Test scheduler logic (schedule, execute, cancel)
- Test reminder validation
- Test error handling

**3.2 Integration Tests**

- Test with actual OpenCode instance
- Test reminder persistence across restarts
- Test session deletion cleanup
- Test concurrent reminders
- Test grace period handling

**3.3 Manual Testing**

```bash
# 1. Install plugin locally
cd opencode-reminders
bun link

# 2. In OpenCode project
cd /path/to/test-project
bun link opencode-reminders

# 3. Add to opencode.json
{
  "plugin": ["opencode-reminders"]
}

# 4. Test scenarios
# - Set one-time reminder (30s)
# - Set recurring reminder (1min)
# - List reminders
# - Remove reminder
# - Delete session (verify cleanup)
# - Restart OpenCode (verify persistence)
```

### Phase 4: Documentation (1-2 hours)

**4.1 README.md**

- Installation instructions
- Usage examples
- Configuration options
- Troubleshooting

**4.2 API Documentation**

- Tool parameters
- Event handling
- Storage format
- Error codes

**4.3 Migration Guide**

- For users of built-in feature
- Breaking changes (if any)
- How to migrate data

### Phase 5: Publishing (1 hour)

**5.1 Prepare for Publishing**

```json
{
  "name": "opencode-reminders",
  "version": "1.0.0",
  "description": "Reminder plugin for OpenCode - schedule actions to run at intervals",
  "keywords": ["opencode", "plugin", "reminders", "scheduler"],
  "author": "Your Name",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/yourusername/opencode-reminders"
  }
}
```

**5.2 Publish to npm**

```bash
npm publish
```

**5.3 Update OpenCode Documentation**

- Add to plugins list
- Add example to docs
- Update AGENTS.md template

---

## Testing Strategy

### Test Files to Migrate

From `packages/opencode/test/reminder/`:

- ✅ `reminder.test.ts` - Schema validation (6 tests)
- ✅ `manager.test.ts` - Core manager (447 tests)
- ✅ `tools.test.ts` - Tool integration (461 tests)
- ✅ `execution.test.ts` - Execution flow (316 tests)
- ✅ `error-handling.test.ts` - Error scenarios (315 tests)
- ✅ `timer-persistence.test.ts` - Storage/restoration (136 tests)
- ✅ `integration.test.ts` - End-to-end (103 tests)
- ✅ `tool-availability.test.ts` - Config/flag control (73 tests)
- ⚠️ `flag.test.ts` - Flag functionality (79 tests) - May not apply to plugin

**Total: 460+ test cases to migrate**

### Adaptations Required

**Replace Internal APIs:**

```typescript
// Before (built-in)
import { Storage } from "../../src/storage/storage"
import { Instance } from "../../src/project/instance"

// After (plugin)
import { saveReminder, loadReminder } from "../src/storage"
// Mock PluginInput for tests
```

**Mock SDK Client:**

```typescript
// Mock session.prompt, session.get, etc.
const mockClient = {
  session: {
    prompt: vi.fn().mockResolvedValue({}),
    get: vi.fn().mockResolvedValue({ id: "ses_123" }),
  },
}

const mockCtx: PluginInput = {
  client: mockClient,
  project: { id: "prj_123", worktree: "/test", time: { created: Date.now() } },
  directory: "/test/.opencode",
  worktree: "/test",
  $: Bun.$,
}
```

### Test Scenarios

**Critical Path:**

1. ✅ Create reminder → Saved to disk
2. ✅ List reminders → Returns active reminders
3. ✅ Execute reminder → Sends prompt to session
4. ✅ Recurring reminder → Reschedules after execution
5. ✅ One-time reminder → Deletes after execution
6. ✅ Remove reminder → Cancels timer and deletes file
7. ✅ Session deleted → Cleans up all reminders
8. ✅ Restart → Restores reminders from disk
9. ✅ Expired reminder → Removed during restore
10. ✅ Invalid session → Cleaned up during restore

**Edge Cases:**

- Concurrent reminder execution
- Permission denial handling
- Corrupted storage files
- Missing storage directory
- Timer precision issues
- Grace period boundary conditions

---

## Trade-offs & Limitations

### What We Lose

**1. Storage Integration**

- ❌ Not part of OpenCode's unified storage system
- ❌ No automatic migration support
- ❌ Separate from other OpenCode data

**2. Logging**

- ❌ No access to internal `Log` service
- ❌ Must use `console.log` or custom logging
- ❌ Logs not integrated with OpenCode's log aggregation

**3. Error Types**

- ❌ Cannot detect `Permission.RejectedError` specifically
- ❌ Must infer permission denials from error names
- ❌ Less precise error handling

**4. State Cleanup**

- ❌ No automatic disposal on project change
- ❌ Must handle cleanup manually via process exit handlers
- ❌ Potential for orphaned timers (minimal risk)

**5. Configuration**

- ❌ No `config.reminders` section in OpenCode config
- ❌ Plugin-specific config would be in separate section
- ❌ Cannot use `Flag.OPENCODE_DISABLE_REMINDERS` directly

### What We Gain

**1. Independence**

- ✅ Separate from core codebase
- ✅ Can be versioned independently
- ✅ Updates don't require OpenCode release

**2. Distribution**

- ✅ Publishable to npm
- ✅ Users can opt-in/opt-out easily
- ✅ Can be forked and customized

**3. Maintainability**

- ✅ Clear API boundaries
- ✅ Easier to test in isolation
- ✅ No internal API dependencies

**4. Example**

- ✅ Demonstrates complex plugin patterns
- ✅ Reference for other plugin authors
- ✅ Shows best practices

### Compatibility Matrix

| Feature            | Built-in | Plugin | Notes                          |
| ------------------ | -------- | ------ | ------------------------------ |
| Timer persistence  | ✅       | ✅     | Via filesystem                 |
| Session cleanup    | ✅       | ✅     | Via event hook                 |
| Config integration | ✅       | ⚠️     | Different config section       |
| Flag support       | ✅       | ⚠️     | Plugin-level toggle            |
| Error handling     | ✅       | ⚠️     | Different error types          |
| Logging            | ✅       | ⚠️     | Console instead of Log service |
| State management   | ✅       | ✅     | Closure-based                  |
| ID generation      | ✅       | ✅     | UUID instead of ascending      |

**Legend:**

- ✅ Fully supported
- ⚠️ Supported with differences
- ❌ Not supported

---

## Reference Implementation

### Complete Plugin Implementation

```typescript
// src/index.ts
import { Plugin, tool } from "@opencode-ai/plugin"
import { z } from "zod"
import path from "path"
import type { Reminder, State } from "./types"
import { ReminderSchema } from "./types"
import { getStorageDir, saveReminder, loadReminder, deleteReminder, listReminders } from "./storage"
import { scheduleTimer, executeReminder, cancelReminder } from "./scheduler"

export const RemindersPlugin: Plugin = async (ctx) => {
  const { client, project, directory } = ctx

  console.log(`[RemindersPlugin] Initializing for project ${project.id}`)

  // Ensure storage directory exists
  const storageDir = await getStorageDir(ctx)

  // Initialize state
  const state: State = {
    reminders: new Map(),
    timers: new Map(),
    projectID: project.id,
  }

  // Restore reminders from storage
  const gracePeriod = 60 * 60 * 1000 // 1 hour
  const now = Date.now()
  let restoredCount = 0
  let expiredCount = 0
  let invalidCount = 0

  const storedReminders = await listReminders(ctx)

  for (const reminder of storedReminders) {
    try {
      // Validate schema
      ReminderSchema.parse(reminder)

      // Validate session exists
      try {
        await client.session.get({ path: { id: reminder.sessionID } })
      } catch {
        console.log(
          `[RemindersPlugin] Session ${reminder.sessionID} no longer exists, removing reminder ${reminder.id}`,
        )
        await deleteReminder(reminder.id, ctx)
        invalidCount++
        continue
      }

      // Check expiration
      if (reminder.time.nextExecution + gracePeriod < now) {
        console.log(`[RemindersPlugin] Reminder ${reminder.id} expired, removing`)
        await deleteReminder(reminder.id, ctx)
        expiredCount++
        continue
      }

      // Valid reminder - restore
      state.reminders.set(reminder.id, reminder)
      await scheduleTimer(reminder, ctx, state)
      restoredCount++
    } catch (error) {
      console.error(`[RemindersPlugin] Failed to restore reminder:`, error)
      // Delete corrupted reminder
      if (reminder.id) {
        await deleteReminder(reminder.id, ctx)
      }
      invalidCount++
    }
  }

  console.log(
    `[RemindersPlugin] Restored ${restoredCount} reminders (${expiredCount} expired, ${invalidCount} invalid)`,
  )

  // Cleanup on process exit
  process.on("beforeExit", () => {
    console.log(`[RemindersPlugin] Cleaning up ${state.timers.size} timers`)
    for (const timer of state.timers.values()) {
      clearTimeout(timer)
    }
  })

  return {
    // Event handling
    async event({ event }) {
      if (event.type === "session.deleted") {
        const sessionID = event.properties.info.id
        console.log(`[RemindersPlugin] Session ${sessionID} deleted, cleaning up reminders`)

        const remindersToCancel = Array.from(state.reminders.values()).filter((r) => r.sessionID === sessionID)

        for (const reminder of remindersToCancel) {
          await cancelReminder(reminder.id, ctx, state)
        }

        console.log(`[RemindersPlugin] Cancelled ${remindersToCancel.length} reminders for session ${sessionID}`)
      }
    },

    // Tools
    tool: {
      reminderadd: tool({
        description: `Set up a reminder to re-execute an action later. Use when user asks to 'remind me to...' or 'check X every Y time'. Actually performs the action when triggered, not just notifies.

Parameters:
  - interval_seconds - Time between executions (minimum 30 seconds)
  - type - Either "one-time" or "recurring"
  - action_prompt - The action to perform when triggered (fully resolved with absolute paths)
  - description - Human-readable label for identifying this reminder

User Pattern Recognition:
  - "in 5 minutes do X" → one-time, 5min delay
  - "every hour do Y" → recurring, 1hr interval
  - "regularly check Z" → recurring, 1min default interval

CRITICAL - Action Prompt Requirements:
  - Must contain fully resolved information (absolute paths, specific names, concrete data)
  - Context may change over time, so avoid vague references
  - Include all necessary details for standalone execution

Examples:
  - "Wait for 5 min and check this file again for instructions" → Creates one-time reminder
  - "Check this website regularly and let me know when it has new information" → Sets recurring 1-minute timer
  - "Check my email every hour and reply that I'm busy" → Creates recurring 1-hour timer`,

        args: {
          interval_seconds: z.number().min(30).describe("Time interval in seconds (minimum 30)"),
          type: z.enum(["one-time", "recurring"]).describe("Whether this reminder runs once or repeatedly"),
          action_prompt: z.string().describe("Fully resolved action with absolute paths and specific identifiers"),
          description: z.string().describe("Human-readable description for identification"),
        },

        async execute(args, context) {
          // Check max reminders limit (default 50)
          const maxReminders = 50
          const existingCount = Array.from(state.reminders.values()).filter(
            (r) => r.sessionID === context.sessionID,
          ).length

          if (existingCount >= maxReminders) {
            const reminders = Array.from(state.reminders.values()).filter((r) => r.sessionID === context.sessionID)
            return `Can't set more reminders, too many reminders already active (${existingCount}/${maxReminders}). Current reminders:\n${reminders.map((r) => `- ${r.userDescription}`).join("\n")}`
          }

          // Create reminder
          const reminder: Reminder = {
            id: crypto.randomUUID(),
            sessionID: context.sessionID,
            projectID: project.id,
            type: args.type,
            interval: args.interval_seconds * 1000,
            originalPrompt: args.action_prompt,
            userDescription: args.description,
            time: {
              created: Date.now(),
              nextExecution: Date.now() + args.interval_seconds * 1000,
            },
            status: "active",
          }

          // Save and schedule
          state.reminders.set(reminder.id, reminder)
          await saveReminder(reminder, ctx)
          await scheduleTimer(reminder, ctx, state)

          console.log(`[RemindersPlugin] Created ${args.type} reminder ${reminder.id}: ${args.description}`)

          return `Reminder set: ${args.description} (${args.type === "one-time" ? "in" : "every"} ${args.interval_seconds} seconds)`
        },
      }),

      reminderlist: tool({
        description: `List all active reminders in this session. Use when user asks 'what reminders do I have' or wants to see scheduled actions.

Returns:
  - Array of active reminders with descriptions
  - Next execution time for each reminder
  - Reminder type (one-time or recurring)

Example Usage: "Show me what I'm waiting for"`,

        args: {},

        async execute(args, context) {
          const reminders = Array.from(state.reminders.values()).filter(
            (r) => r.sessionID === context.sessionID && r.status === "active",
          )

          if (reminders.length === 0) {
            return "No active reminders in this session."
          }

          const output = reminders
            .map((r) => {
              const nextIn = Math.round((r.time.nextExecution - Date.now()) / 1000)
              const nextText = nextIn > 0 ? `in ${nextIn}s` : "overdue"
              return `- ${r.userDescription} (${r.type}, next execution ${nextText})`
            })
            .join("\n")

          return `Active reminders:\n${output}`
        },
      }),

      reminderremove: tool({
        description: `Cancel a scheduled reminder. Use when user asks to 'stop checking X' or 'cancel the reminder for Y'. Matches user's description pattern to existing reminders.

Parameters:
  - description_pattern - Text pattern to match against reminder descriptions

Example Usage: "Stop checking my email"

Response Format:
  - Success: "Reminder cancelled: No longer checking your email every hour"
  - Error: "No matching reminder found" if pattern doesn't match any active reminders

Usage notes:
  - Pattern matching is flexible and attempts to find best match
  - Use reminderlist first to see available reminders if uncertain
  - Only removes reminders from current session`,

        args: {
          description_pattern: z
            .string()
            .describe("What the user wants to stop (will match against reminder descriptions)"),
        },

        async execute(args, context) {
          const reminders = Array.from(state.reminders.values()).filter(
            (r) => r.sessionID === context.sessionID && r.status === "active",
          )

          const pattern = args.description_pattern.toLowerCase()
          const matches = reminders.filter(
            (r) =>
              r.userDescription.toLowerCase().includes(pattern) || r.originalPrompt.toLowerCase().includes(pattern),
          )

          if (matches.length === 0) {
            const activeList = reminders.map((r) => `- ${r.userDescription}`).join("\n") || "None"
            return `No matching reminder found for "${args.description_pattern}". Active reminders:\n${activeList}`
          }

          if (matches.length > 1) {
            const matchList = matches.map((r) => `- ${r.userDescription}`).join("\n")
            return `Multiple reminders match "${args.description_pattern}":\n${matchList}\nPlease be more specific.`
          }

          const reminder = matches[0]
          await cancelReminder(reminder.id, ctx, state)

          console.log(`[RemindersPlugin] Cancelled reminder ${reminder.id} via user request`)

          return `Reminder cancelled: ${reminder.userDescription}`
        },
      }),
    },
  }
}

// Default export for easy import
export default RemindersPlugin
```

### README.md Template

````markdown
# OpenCode Reminders Plugin

Schedule actions to run at intervals in OpenCode sessions. Set one-time or recurring reminders that execute prompts automatically.

## Features

- ⏰ **One-time reminders** - Execute an action after a delay
- 🔄 **Recurring reminders** - Execute an action at regular intervals
- 💾 **Persistent** - Survives OpenCode restarts
- 🧹 **Auto-cleanup** - Removes reminders when sessions are deleted
- 🔒 **Session-scoped** - Reminders tied to specific sessions

## Installation

### npm Package

```bash
npm install opencode-reminders
```

Add to your `opencode.json`:

```json
{
  "plugin": ["opencode-reminders"]
}
```

### Local Plugin

Copy `reminders.ts` to `.opencode/plugin/reminders.ts` in your project.

## Usage

### Set a Reminder

**One-time (execute once after delay):**

```
"In 5 minutes, check the build status"
```

**Recurring (execute repeatedly):**

```
"Every hour, check for new emails and summarize them"
```

### List Reminders

```
"What reminders do I have?"
"Show my active reminders"
```

### Remove a Reminder

```
"Stop checking my email"
"Cancel the build status reminder"
```

## How It Works

1. **Storage** - Reminders saved as JSON files in `.opencode-reminders/`
2. **Scheduling** - Uses `setTimeout` to schedule executions
3. **Execution** - Sends prompt to session when timer fires
4. **Cleanup** - Removes reminders when session deleted

## Configuration

Currently no configuration options. Future versions may add:

- Max reminders per project
- Min interval between executions
- Default reminder type

## Data Storage

Reminders stored in:

```
.opencode-reminders/
  <project-id>/
    <reminder-id>.json
```

Add to `.gitignore`:

```
.opencode-reminders/
```

## Troubleshooting

**Reminders not executing?**

- Check session still exists
- Verify reminder shows in list
- Check console for errors

**Reminders lost after restart?**

- Ensure storage directory not deleted
- Check file permissions

**Too many reminders?**

- Default limit: 50 per session
- Remove old reminders before adding new ones

## Development

```bash
# Install dependencies
bun install

# Build
bun run build

# Test
bun test

# Link for local development
bun link
```

## License

MIT
````

---

## Next Steps

### Immediate Actions

1. ✅ **Document created** - This migration plan
2. ⏭️ **Get approval** - Review with team/stakeholders
3. ⏭️ **Create plugin package** - Follow Phase 1
4. ⏭️ **Implement core** - Follow Phase 2
5. ⏭️ **Test thoroughly** - Follow Phase 3
6. ⏭️ **Document & publish** - Follow Phase 4-5

### Questions to Answer

1. **Distribution:** npm package or local plugin first?
2. **Versioning:** Start at 1.0.0 or 0.1.0?
3. **Branding:** "opencode-reminders" or different name?
4. **Maintenance:** Who maintains after migration?
5. **Migration:** Support automatic migration from built-in?

### Success Criteria

- [ ] All 460+ tests passing
- [ ] Plugin installable via npm
- [ ] Documentation complete
- [ ] No regressions from built-in version
- [ ] Performance equivalent or better
- [ ] Example added to OpenCode docs

---

## Appendix

### File Checklist

**From Built-in (to migrate):**

- ✅ `packages/opencode/src/reminder/manager.ts`
- ✅ `packages/opencode/src/reminder/reminder.ts`
- ✅ `packages/opencode/src/tool/reminderadd.ts`
- ✅ `packages/opencode/src/tool/reminderadd.txt`
- ✅ `packages/opencode/src/tool/reminderlist.ts`
- ✅ `packages/opencode/src/tool/reminderlist.txt`
- ✅ `packages/opencode/src/tool/reminderremove.ts`
- ✅ `packages/opencode/src/tool/reminderremove.txt`
- ✅ All test files in `packages/opencode/test/reminder/`

**New Plugin Files:**

- ⏭️ `src/index.ts` - Main plugin
- ⏭️ `src/types.ts` - Type definitions
- ⏭️ `src/storage.ts` - Storage operations
- ⏭️ `src/scheduler.ts` - Timer management
- ⏭️ `package.json` - Package metadata
- ⏭️ `tsconfig.json` - TypeScript config
- ⏭️ `README.md` - Documentation
- ⏭️ `test/` - Migrated tests

### API Mapping

| Built-in API             | Plugin Equivalent         | Notes            |
| ------------------------ | ------------------------- | ---------------- |
| `Storage.write()`        | `Bun.write()`             | Filesystem       |
| `Storage.read()`         | `Bun.file().json()`       | Filesystem       |
| `Storage.list()`         | `Bun.Glob().scan()`       | Filesystem       |
| `Storage.remove()`       | `Bun.$\`rm\``             | Shell command    |
| `Instance.state()`       | Closure state             | Function scope   |
| `Bus.subscribe()`        | Plugin `event` hook       | Event filtering  |
| `SessionPrompt.prompt()` | `client.session.prompt()` | SDK method       |
| `Identifier.ascending()` | `crypto.randomUUID()`     | Standard UUID    |
| `Config.get()`           | Plugin `config` hook      | Via hook         |
| `Log.info()`             | `console.log()`           | Standard logging |

### Timeline Estimate

| Phase      | Duration       | Deliverable                 |
| ---------- | -------------- | --------------------------- |
| Setup      | 1-2 hours      | Package structure           |
| Core       | 4-6 hours      | Working plugin              |
| Testing    | 2-3 hours      | Passing tests               |
| Docs       | 1-2 hours      | README + API docs           |
| Publishing | 1 hour         | npm package                 |
| **Total**  | **9-14 hours** | **Production-ready plugin** |

---

**Document Version:** 1.0  
**Last Updated:** 2025-10-17  
**Status:** Ready for Implementation  
**Next Review:** After Phase 1 completion
