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
bun install
```

This will install dependencies and copy the plugin to `~/.config/opencode/plugin/reminders/`.

OpenCode will automatically discover it when you start the TUI.

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

## Development

### Install Dependencies

```bash
cd .opencode/plugin/reminders
bun install
```

### Type Check

```bash
bun run tsc --noEmit
```

## Architecture

This plugin demonstrates a multi-file structure:

- **`index.ts`** - Main plugin export with tool definitions and event handlers
- **`types.ts`** - TypeScript types and Zod schemas
- **`storage.ts`** - Filesystem operations for persistence
- **`scheduler.ts`** - Timer management and execution logic
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
