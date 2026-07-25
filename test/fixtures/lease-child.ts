import { $ } from "bun"
import type { PluginInput } from "@opencode-ai/plugin"
import { acquireExecutionLease } from "../../leases"

const [directory, reminderID, occurrence] = process.argv.slice(2)
if (!directory || !reminderID || !occurrence) throw new Error("missing lease child arguments")

const ctx: PluginInput = {
  client: {} as any,
  project: { id: "lease-project", worktree: directory, time: { created: Date.now() } },
  directory,
  worktree: directory,
  $,
}
const lease = await acquireExecutionLease(reminderID, Number(occurrence), ctx)
process.stdout.write(lease.status === "acquired" ? "winner\n" : "loser\n")

if (lease.status === "acquired") {
  await new Response(Bun.stdin.stream()).text()
  await lease.lease.release()
}
