import { send } from "../cli/client.ts";
import { record, type Fields } from "../protocol.ts";
import type { QueueJournal } from "./queue-journal.ts";

export function handedOff(run: Fields): boolean {
  const outcome = record(run["outcome"]);
  return (
    run["state"] === "completed" &&
    outcome?.["kind"] === "handoff_requested" &&
    outcome["issueUpdate"] !== "failed"
  );
}

async function queuedRun(
  runtimeDirectory: string,
  runId: string,
): Promise<Fields | undefined> {
  const reply = await send(runtimeDirectory, {
    operation: "status",
    parameters: { runIds: [runId] },
  });
  if (reply.kind === "error") return undefined;
  const runs: unknown = reply.result["runs"];
  return Array.isArray(runs) ? record(runs[0]) : undefined;
}

async function chainHandedOff(
  runtimeDirectory: string,
  runId: string,
): Promise<boolean> {
  const run = await queuedRun(runtimeDirectory, runId);
  if (run === undefined) return false;
  if (handedOff(run)) return true;
  const next = run["continuedBy"];
  return typeof next === "string" && chainHandedOff(runtimeDirectory, next);
}

export async function clearContinuedFailures(
  runtimeDirectory: string,
  pending: QueueJournal,
): Promise<void> {
  for (const runId of pending.failures) {
    if (!(await chainHandedOff(runtimeDirectory, runId))) continue;
    pending.failures.length = 0;
    await pending.save();
    process.stderr.write(
      `Queue failure streak cleared: a continuation of ${runId} handed off\n`,
    );
    return;
  }
}
