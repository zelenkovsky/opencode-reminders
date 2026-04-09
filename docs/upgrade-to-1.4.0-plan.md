# Upgrade Plan: opencode-reminders → @opencode-ai/plugin 1.4.0

## Current State

- `@opencode-ai/plugin`: `^0.15.7`
- `@opencode-ai/sdk`: `^0.15.7`
- Latest version: **1.4.0** (released April 8, 2026)
- Source repo: https://github.com/anomalyco/opencode

---

## Breaking Changes Summary

### 1. Plugin Signature — Now Accepts `options` Parameter

**Old (0.15.7):**
```typescript
export type Plugin = (input: PluginInput) => Promise<Hooks>
```

**New (1.4.0):**
```typescript
export type Plugin = (input: PluginInput, options?: PluginOptions) => Promise<Hooks>
```

### 2. Plugin Export Format — New `PluginModule` Type

**New in 1.4.0:**
```typescript
export type PluginModule = {
  id?: string
  server: Plugin
  tui?: never
}
```

The bare function export may no longer be accepted by the loader. The safe export format is now:
```typescript
export default {
  id: "opencode-reminders",
  server: RemindersPlugin,
} satisfies PluginModule
```

### 3. `PluginInput` Has New `serverUrl` Property

```typescript
export type PluginInput = {
  client: ReturnType<typeof createOpencodeClient>
  project: Project
  directory: string
  worktree: string
  serverUrl: URL        // ← NEW
  $: BunShell
}
```

No code changes required (existing fields unchanged), but test mocks must include it.

### 4. `ToolContext` Has New Properties

**Old:**
```typescript
{ sessionID, messageID, agent, abort }
```

**New:**
```typescript
{ sessionID, messageID, agent, directory, worktree, abort, metadata(), ask() }
```

No breaking changes for current usage — `context.sessionID` still works. New fields are additive.

### 5. Zod Import Path

The plugin internally changed from `import { z } from "zod/v4"` to `import { z } from "zod"`. Our code already imports from `"zod"` directly, so no change needed. Verify no resolution conflicts after upgrade.

### 6. `Hooks.config` Input Type Changed

Old: accepts raw SDK `Config`.
New: accepts `Omit<SDKConfig, "plugin"> & { plugin?: Array<string | [string, PluginOptions]> }`.

Our code casts to `any` anyway (`index.ts:94`), so no functional breakage.

### 7. SDK Client API (`session.prompt`, `tui.showToast`)

Both methods still exist in 1.4.0 with compatible signatures. No changes needed.

---

## Change Checklist

### Critical

- [ ] **`package.json`** — Bump dependency versions
  ```diff
  -  "@opencode-ai/plugin": "^0.15.7",
  -  "@opencode-ai/sdk": "^0.15.7",
  +  "@opencode-ai/plugin": "^1.4.0",
  +  "@opencode-ai/sdk": "^1.4.0",
  ```

- [ ] **Run `bun install`** — Reinstall dependencies after version bumps

- [ ] **Run `tsc --noEmit`** — Verify no type errors after upgrade

### Important

- [ ] **`index.ts:1`** — Update import to include `PluginModule`
  ```diff
  - import { Plugin } from "@opencode-ai/plugin"
  + import type { Plugin, PluginModule } from "@opencode-ai/plugin"
  ```

- [ ] **`index.ts:11`** — Add optional `options` parameter
  ```diff
  - const RemindersPlugin: Plugin = async (ctx) => {
  + const RemindersPlugin: Plugin = async (ctx, options) => {
  ```

- [ ] **`index.ts:124`** — Change default export to `PluginModule` format
  ```diff
  - export default RemindersPlugin
  + export default {
  +   id: "opencode-reminders",
  +   server: RemindersPlugin,
  + } satisfies PluginModule
  ```

- [ ] **`test/integration.test.ts`** — Add `serverUrl` to mock context (line ~33)
  ```diff
    directory: tmpDir,
    worktree: tmpDir,
  + serverUrl: new URL("http://localhost:3000"),
    $: $,
  ```

- [ ] **`test/scheduler.test.ts`** — Add `serverUrl` to mock context (line ~25)
  ```diff
    directory: tmpDir,
    worktree: tmpDir,
  + serverUrl: new URL("http://localhost:3000"),
    $: $,
  ```

### Optional (Nice to Have)

- [ ] Leverage `PluginOptions` for configuration instead of/alongside the `config` hook. OpenCode 1.4.0 supports `["opencode-reminders", { reminders: {...} }]` syntax in `opencode.json`.

- [ ] Use new `ToolContext.metadata()` to enhance tool results with titles and structured metadata.

- [ ] Use `ToolContext.ask()` to request permissions before executing actions.

- [ ] Explore new hooks for automation and session awareness.

---

## New Hooks Available in 1.4.0

These are not required but can enhance the plugin:

| Hook | Description |
|------|-------------|
| `auth` | Authentication hooks for providers |
| `provider` | Provider model hooks |
| `"chat.message"` | Intercept incoming messages |
| `"chat.params"` | Modify LLM parameters |
| `"chat.headers"` | Modify request headers |
| `"permission.ask"` | Permission interception |
| `"command.execute.before"` | Pre-command hooks |
| `"tool.execute.before"` | Pre-tool execution hooks |
| `"tool.execute.after"` | Post-tool execution hooks |
| `"shell.env"` | Shell environment hooks |
| `"experimental.chat.messages.transform"` | Transform messages |
| `"experimental.chat.system.transform"` | Transform system prompts |
| `"experimental.session.compacting"` | Session compaction hooks |
| `"experimental.text.complete"` | Text completion hooks |
| `"tool.definition"` | Modify tool definitions sent to LLM |

---

## ToolContext.metadata() Usage Guide

The `metadata()` method is available on the `context` object passed to your tool's `execute()` function. Call it **after** the action completes to set the tool result's title and structured metadata.

### reminderadd — Show what was created

```typescript
// In tools/reminderadd.ts, execute() function, before return:
context.metadata({
  title: `⏰ ${args.type === "one-time" ? "One-time" : "Recurring"} reminder set`,
  metadata: {
    reminderID: reminder.id,
    description: args.description,
    type: args.type,
    intervalSeconds: args.interval_seconds,
    nextExecutionIn: args.interval_seconds,
  },
})
```

**Result in TUI:** Tool result shows `⏰ Recurring reminder set` as the title, with structured metadata (ID, timing, type) attached.

### reminderlist — Show count and next execution

```typescript
// In tools/reminderlist.ts, execute() function, before return:
context.metadata({
  title: `📋 ${reminders.length} active reminder${reminders.length === 1 ? "" : "s"}`,
  metadata: {
    count: reminders.length,
    reminders: reminders.map((r) => ({
      id: r.id,
      description: r.userDescription,
      type: r.type,
      nextExecutionIn: Math.round((r.time.nextExecution - Date.now()) / 1000),
    })),
  },
})
```

**Result in TUI:** Title shows `📋 3 active reminders`, metadata has full IDs and timings for programmatic access.

### reminderremove — Show what was cancelled

```typescript
// In tools/reminderremove.ts, execute() function, after cancelling:
context.metadata({
  title: `🗑️ ${matches.length} reminder${matches.length === 1 ? "" : "s"} cancelled`,
  metadata: {
    count: matches.length,
    cancelled: matches.map((r) => ({
      id: r.id,
      description: r.userDescription,
    })),
  },
})
```

**Result in TUI:** Title shows `🗑️ 2 reminders cancelled`, metadata contains IDs of removed reminders.

### Key Points

- **Call `metadata()` AFTER the action** — It's for result display, not input validation.
- **Title supports emoji** (⏰, 📋, 🗑️) — This is what users see as the tool result header in the TUI.
- **Metadata is structured JSON** — Can be accessed by future MCP tools or used for debugging.
- **The `context` object** — Already passed to your `execute(args, context)` function; just call `context.metadata(...)` before returning.

---

## Useful Hooks for This Plugin

### `"permission.ask"` — Auto-approve reminder tool execution

When reminders fire and trigger `session.prompt()`, opencode's built-in tools (bash, edit, etc.) will request permissions. You can auto-approve for reminder-initiated sessions:

```typescript
"permission.ask": async (input, output) => {
  // Check if this permission request is from a reminder-initiated session
  const isFromReminder = Array.from(state.reminders.values())
    .some(r => r.sessionID === input.sessionID)
  
  if (isFromReminder) {
    output.status = "allow" // Auto-approve all tools in reminder sessions
  }
}
```

**Benefit:** Reminders can run unattended without repeatedly asking for permission.

---

### `"tool.execute.after"` — Log/track tool completions

React to tool completions in reminder sessions:

```typescript
"tool.execute.after": async (input, output) => {
  const isReminderSession = Array.from(state.reminders.values())
    .some(r => r.sessionID === input.sessionID)
  
  if (isReminderSession) {
    logger.info(`[RemindersPlugin] Tool ${input.tool} completed: ${output.title}`)
  }
}
```

**Benefit:** Better debugging and audit trail for what happens during reminder execution.

---

### `"tool.definition"` — Enhance tool descriptions dynamically

Inject dynamic information into tool descriptions before they're sent to the LLM:

```typescript
"tool.definition": async (input, output) => {
  if (input.toolID === "reminderlist") {
    const count = Array.from(state.reminders.values()).filter(
      r => r.status === "active"
    ).length
    output.description = `${output.description}\n\nCurrently ${count} active reminder(s) in this session.`
  }
}
```

**Benefit:** The LLM knows about active reminders without needing to call the tool first.

---

### `"experimental.session.compacting"` — Preserve reminder context

When opencode compacts a long session, reminder awareness might be lost. Inject it:

```typescript
"experimental.session.compacting": async (input, output) => {
  const sessionReminders = Array.from(state.reminders.values())
    .filter(r => r.sessionID === input.sessionID && r.status === "active")
  
  if (sessionReminders.length > 0) {
    const list = sessionReminders
      .map(r => `- ${r.userDescription} (${r.type}, every ${r.interval / 1000}s)`)
      .join("\n")
    output.context.push(
      `Active reminders in this session:\n${list}\nThese scheduled actions are running and should be preserved.`
    )
  }
}
```

**Benefit:** After session compaction, the LLM still knows about active reminders.

---

### `"chat.message"` — Auto-inject reminder context

Automatically append reminder status to user messages:

```typescript
"chat.message": async (input, output) => {
  const activeReminders = Array.from(state.reminders.values())
    .filter(r => r.sessionID === input.sessionID && r.status === "active")
  
  if (activeReminders.length > 0) {
    output.parts.push({
      type: "text",
      text: `[System: ${activeReminders.length} active reminder(s) in this session]`
    })
  }
}
```

**Benefit:** The LLM always sees reminder context without explicit user mention.

---

### `"chat.params"` / `"chat.headers"` — Adjust LLM behavior for reminders

If you need to tweak LLM parameters specifically for reminder-triggered prompts:

```typescript
"chat.params": async (input, output) => {
  const isReminder = Array.from(state.reminders.values())
    .some(r => r.sessionID === input.sessionID)
  
  if (isReminder) {
    // More deterministic output for automated reminders
    output.temperature = 0.1
    output.topP = 0.9
  }
}
```

**Benefit:** More predictable LLM responses during automated reminder execution.

---

## Notes

1. **Repo has moved**: The source is now at `anomalyco/opencode` (not `opencode-ai/opencode`, which was a Go-based project archived and renamed to Crush). The npm packages remain under `@opencode-ai/` scope.

2. **Test after upgrade**: Run `bun test` to verify all integration and unit tests pass after making changes.

3. **Update integration test plugin calls**: The plugin return shape is the same (still returns `Hooks`), so `plugin.tool!.reminderadd.execute(...)` etc. should continue working. However, if the export changes to `PluginModule`, tests that call `RemindersPlugin(ctx)` directly need to call `RemindersPlugin.server(ctx)` or import the inner function.

---

## References

- npm: https://registry.npmjs.org/@opencode-ai/plugin/latest
- Plugin types (1.4.0): https://unpkg.com/@opencode-ai/plugin@1.4.0/dist/index.d.ts
- Plugin types (0.15.7): https://unpkg.com/@opencode-ai/plugin@0.15.7/dist/index.d.ts
- Tool types (1.4.0): https://unpkg.com/@opencode-ai/plugin@1.4.0/dist/tool.d.ts
- Source repo: https://github.com/anomalyco/opencode
- Source plugin code: https://github.com/anomalyco/opencode/tree/dev/packages/plugin
