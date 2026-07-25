# Reminders Plugin Tests

Run the suite with `bun test`; it uses isolated temporary project directories and child processes
only. `bun x tsc --noEmit` checks the test and plugin TypeScript sources.

Coverage includes persistence, agent capture and forwarding, scheduler execution and generation
fencing, active cancellation, restoration cadence, atomic lease ownership/recovery, and multiprocess
prompt contention. Persistence-failure tests verify startup skip-overdue retention and capped retry
rates while the prior JSON remains readable. Child-process tests use strict stdin barriers and are
responsible for closing their children during cleanup.

Cancellation tests also pause a completed reconciliation read, finish durable cancellation, and
then release the stale continuation to verify it cannot restore local state or a timer.

The suite intentionally does not claim exact-once prompt delivery across a crash or storage failure
after prompt acceptance. It tests the plugin's same-host coordination and reconciliation behavior.
