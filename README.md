# OpenCode Reminders Plugin

Schedule actions to run at intervals in OpenCode sessions. Set one-time or recurring reminders that execute prompts automatically.

## Features

- ⏰ **One-time reminders** - Execute an action after a delay
- 🔄 **Recurring reminders** - Execute an action at regular intervals
- 💾 **Persistent** - Survives OpenCode restarts
- 🧹 **Auto-cleanup** - Removes reminders when sessions are deleted
- 🔒 **Session-scoped** - Reminders tied to specific sessions

## Installation

```bash
bun install opencode-reminders
```

Then add to your `opencode.json`:

```json
{
  "plugin": [
    "opencode-reminders"
  ]
}
```

OpenCode will automatically load the plugin when you start the TUI.

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

1. **Storage** - Reminders saved as JSON files in `.opencode/reminders/<project-id>/`
2. **Scheduling** - Uses `setTimeout` to schedule executions
3. **Execution** - Sends prompt to session when timer fires
4. **Cleanup** - Removes reminders when session deleted

## Multi-Process Semantics

When independent OpenCode server processes load the same reminder directory on one host, an
occurrence lease prevents them from submitting the same prompt concurrently. Leases and reminder
JSON updates use same-directory atomic filesystem operations. A losing process keeps an unref'd
reconciliation timer, reloads durable state, and schedules the winner's next recurring occurrence.
Post-prompt recurrence updates and every plugin cancellation/restore cleanup share a short-lived
per-reminder mutation lock, so the durable read-and-transition cannot race a deletion. The lock is
not held while the prompt API runs.

Reconciliation retries use capped exponential backoff. A recurring occurrence found overdue during
startup retains its skip-overdue policy across read or atomic-write failures, so unchanged old JSON
is never reinterpreted as a normal occurrence and prompted. Normal runtime failures retain the
occurrence for an at-least-once retry; the retry history resets after durable state advances into the
future.

Within one server process, plugin generations also fence hot reloads. Reinitialization clears old
timers, aborts active requests, waits for mutations already in progress, and prevents stale timer or
reconciliation callbacks from changing replacement state. Cancellation aborts the active local
request immediately, then uses the same mutation lock as cross-process transitions.

Reconciliation reads are fenced per reminder and revalidated under the mutation lock. Once local
cancellation returns, a read that completed before deletion cannot restore stale list state or a
timer, even if its continuation resumes later.

This is deliberately not a claim of crash-proof exactly-once delivery. Any process, storage, or lock
failure after the prompt API accepts a request but before its durable transition can lead to retry.
That is at-least-once crash semantics; true exactly-once delivery requires idempotency support in the
prompt API. Likewise, cancellation does not hold a lock across prompting: if an owner has already
passed durable validation, a prompt can still be submitted even when cancellation returns first.
The post-prompt durable transition remains fenced, so cancellation cannot intentionally resurrect or
reschedule the reminder after deletion.

The lease protocol assumes same-host processes and a local filesystem with atomic hard links,
exclusive create, and rename. It is not intended to coordinate hosts or provide NFS/distributed
filesystem safety. Linux detects a dead or reused PID using `/proc/<pid>/stat` process start time.
Other platforms may acquire leases normally, but only reclaim a lease when `process.kill(pid, 0)`
reports `ESRCH`; a reused PID is conservatively treated as live and can leave a stale lease until
manual cleanup rather than risk a duplicate prompt.

A stale `.recover` guard is never reclaimed automatically. This avoids a replacement race that could
delete a live guard or lease, at the cost of manual cleanup after a recovery-process crash.

Reminders capture the creating tool context's optional agent name and pass it back to the prompt API
when they execute. Existing reminder files without `agent` remain valid and omit the prompt field.

## Data Storage

Reminders stored in:

```
.opencode/
  reminders/
    <project-id>/
      <reminder-id>.json
    .gitignore
```

The `.gitignore` file is automatically created to exclude reminder data from version control.

## Configuration

The plugin supports the following configuration options (set via plugin config):

```typescript
{
  reminders: {
    enabled: true,                    // Enable/disable plugin
    max_reminders_per_project: 50,    // Maximum reminders per project
    min_interval_seconds: 30,         // Minimum interval between executions
    notifications: {
      enabled: true                   // Enable/disable toast notifications
    }
  }
}
```

## Development

### Install Dependencies

```bash
bun install
```

### Type Check

```bash
tsc --noEmit
```

### Run Tests

```bash
# Run all tests
bun test

# Run specific test suites
bun test test/types.test.ts
bun test test/storage.test.ts
bun test test/logger.test.ts
bun test test/config.test.ts
bun test test/scheduler.test.ts
bun test test/integration.test.ts

# Watch mode
bun test --watch

# Using npm scripts
npm run test
npm run test:types
npm run test:storage
npm run test:logger
npm run test:integration
npm run test:watch
```

**Test Coverage:** Comprehensive test suite covering types, storage, logging, configuration, scheduling, and integration.

## Architecture

This plugin demonstrates a multi-file structure:

- **`index.ts`** - Main plugin export with tool definitions and event handlers
- **`types.ts`** - TypeScript types and Zod schemas
- **`storage.ts`** - Filesystem operations for persistence
- **`scheduler.ts`** - Timer management and execution logic
- **`logger.ts`** - Logging functionality with configurable levels
- **`tools/`** - Tool implementations (reminderadd, reminderlist, reminderremove)
- **`test/`** - Comprehensive test suite
- **`package.json`** - Dependencies configuration
- **`tsconfig.json`** - TypeScript configuration

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

## License

MIT
