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
    min_interval_seconds: 30          // Minimum interval between executions
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

# Run specific test suite
bun test test/types.test.ts
bun test test/storage.test.ts
bun test test/scheduler.test.ts
bun test test/integration.test.ts

# Watch mode
bun test --watch
```

**Test Coverage:** 35+ tests covering types, storage, scheduling, and integration.

## Architecture

This plugin demonstrates a multi-file structure:

- **`index.ts`** - Main plugin export with tool definitions and event handlers
- **`types.ts`** - TypeScript types and Zod schemas
- **`storage.ts`** - Filesystem operations for persistence
- **`scheduler.ts`** - Timer management and execution logic
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
