# TUI Notification Exploration for Reminders Plugin

## Summary

The OpenCode SDK provides a `client.tui.showToast()` method for displaying TUI notifications. This can be used to show notifications when reminders execute.

## Key Findings

### 1. TUI Toast Notification API

**Method:** `ctx.client.tui.showToast()`

**Type Definition:**
```typescript
export type TuiShowToastData = {
    body?: {
        title?: string;         // Optional title
        message: string;        // Required message text
        variant: "info" | "success" | "warning" | "error";  // Notification type
    };
    path?: never;
    query?: {
        directory?: string;
    };
    url: "/tui/show-toast";
};
```

**Example Usage:**
```typescript
await ctx.client.tui.showToast({
    body: {
        title: "Reminder Executed",
        message: "Daily backup completed",
        variant: "success"
    }
});
```

### 2. Passing Reminder Description

The reminder description can easily be passed to the notification:

```typescript
// In scheduler.ts executeReminder function:
await ctx.client.tui.showToast({
    body: {
        title: "Reminder",
        message: reminder.userDescription,  // Use the stored description
        variant: "info"
    }
});
```

### 3. Session Filtering (Current vs Non-Current Sessions)

**Challenge:** Determining if a session is "current" (actively being viewed in the TUI)

**Available Information:**
- Each reminder has `reminder.sessionID` 
- Tool execution context has `context.sessionID`
- Event system has `EventSessionIdle` which indicates when a session becomes idle

**Limitation:** The SDK doesn't expose a direct "current session" or "active session" API that tells us which session is currently displayed in the TUI.

**Possible Approaches:**

#### Option A: Track Active Session via Events (Complex)
```typescript
// Listen to session.idle events to track which session is NOT idle
// This would require significant refactoring
let activeSessionID: string | null = null;

// In event hook:
if (event.type === "session.idle") {
    // This session became idle, but doesn't tell us which is active
}
```

**Problem:** No corresponding "session.active" event exists

#### Option B: Show Notifications Only for Non-Executing Sessions
```typescript
// In executeReminder():
// Only show notification if reminder's session is different from "current" one
// But we can't reliably determine "current" session

// This approach is not feasible without additional SDK support
```

#### Option C: Always Show Notifications (Simple & Reliable)
```typescript
// Show notifications for all reminder executions
// Let the TUI handle display logic
// Users see notifications even for current session

await ctx.client.tui.showToast({
    body: {
        title: "Reminder",
        message: reminder.userDescription,
        variant: "info"
    }
});
```

#### Option D: Configuration Option
```typescript
// Add plugin configuration for notification behavior
{
    reminders: {
        notifications: {
            enabled: true,
            show_for_current_session: false  // User preference
        }
    }
}

// However, we still can't determine "current" session programmatically
```

### 4. Recommended Implementation

**Best Approach:** Show notifications for ALL reminder executions (Option C)

**Rationale:**
1. **Simple & Reliable:** No complex session tracking needed
2. **User Awareness:** Users always know when reminders execute
3. **Consistency:** Same behavior regardless of which session is active
4. **Future-Proof:** If SDK adds session tracking later, we can enhance

**Implementation Location:**
- `scheduler.ts` in the `executeReminder()` function
- Show notification BEFORE executing the prompt
- Include error notifications for failed executions

**Code Example:**
```typescript
export async function executeReminder(reminder: Reminder, ctx: PluginInput, state: State): Promise<void> {
  logger.info(`Executing reminder ${reminder.id}: ${reminder.userDescription}`)

  // Show notification before execution
  try {
    await ctx.client.tui.showToast({
      body: {
        title: "Reminder",
        message: reminder.userDescription,
        variant: "info"
      }
    })
  } catch (error) {
    logger.error(`Failed to show notification for reminder ${reminder.id}:`, error)
    // Continue with execution even if notification fails
  }

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

    reminder.time.lastExecution = Date.now()

    if (reminder.type === "recurring") {
      reminder.time.nextExecution = Date.now() + reminder.interval
      state.reminders.set(reminder.id, reminder)
      await saveReminder(reminder, ctx)
      await scheduleTimer(reminder, ctx, state)
      logger.info(`Recurring reminder ${reminder.id} rescheduled`)
    } else {
      await cancelReminder(reminder.id, ctx, state)
      logger.info(`One-time reminder ${reminder.id} completed and removed`)
      
      // Show completion notification
      await ctx.client.tui.showToast({
        body: {
          message: `Reminder completed: ${reminder.userDescription}`,
          variant: "success"
        }
      }).catch(err => logger.error("Failed to show completion notification:", err))
    }
  } catch (error: any) {
    logger.error(`Reminder ${reminder.id} execution failed:`, error)
    
    // Show error notification
    await ctx.client.tui.showToast({
      body: {
        title: "Reminder Failed",
        message: reminder.userDescription,
        variant: "error"
      }
    }).catch(err => logger.error("Failed to show error notification:", err))

    // ... existing error handling
  }
}
```

### 5. Alternative: Session-Aware Notifications (Future Enhancement)

If the SDK adds support for detecting the current/active session in the future, the implementation could be enhanced:

```typescript
// Hypothetical future API:
const currentSession = await ctx.client.session.getCurrent()

// Only show notification if reminder is for a different session
if (reminder.sessionID !== currentSession.id) {
    await ctx.client.tui.showToast({
        body: {
            title: "Reminder (Background)",
            message: reminder.userDescription,
            variant: "info"
        }
    })
}
```

## Conclusion

1. **TUI notifications are fully supported** via `ctx.client.tui.showToast()`
2. **Reminder description can easily be passed** using `reminder.userDescription`
3. **Session filtering is NOT currently possible** - no API to determine "current" session
4. **Recommended approach:** Show notifications for all executions
5. **Implementation:** Add notification calls in `scheduler.ts` executeReminder function

## Next Steps (if implementing)

1. Update `scheduler.ts` to add `tui.showToast()` calls
2. Add notification on execution start (info variant)
3. Add notification on one-time completion (success variant)  
4. Add notification on error (error variant)
5. Test with both one-time and recurring reminders
6. Consider adding config option to disable notifications
