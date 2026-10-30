import { send } from "../cli/client.ts";
import { record } from "../protocol.ts";

function queueBusy(value: unknown): number | undefined {
  const busy = record(value)?.["busy"];
  if (typeof busy !== "number") return undefined;
  if (!Number.isSafeInteger(busy) || busy < 0)
    throw new Error("invalid-queue-status");
  return busy;
}

export async function queueStatus(settings: {
  readonly runtimeDirectory: string;
  readonly workflowId: string;
}): Promise<{ readonly busy: number; readonly holding: boolean }> {
  let count = 0;
  let after: string | null = "";
  do {
    const reply = await send(settings.runtimeDirectory, {
      operation: "status",
      parameters: { after, limit: 500 },
    });
    if (reply.kind === "error") throw new Error(reply.error.code);
    const busy = queueBusy(reply.result["queue"]);
    if (busy !== undefined)
      return {
        busy,
        holding:
          record(record(reply.result["queue"])?.["spend"])?.["holding"] ===
          true,
      };
    const runs = reply.result["runs"];
    if (!Array.isArray(runs)) throw new Error("invalid-run-list");
    count += runs.filter((value: unknown) => {
      const run = record(value);
      return (
        run?.["workflowId"] === settings.workflowId &&
        !["completed", "failed", "cancelled"].includes(String(run["state"]))
      );
    }).length;
    const next = reply.result["next"];
    if (next !== null && (typeof next !== "string" || next <= after))
      throw new Error("invalid-run-page");
    after = next;
  } while (after !== null);
  return { busy: count, holding: false };
}

export function spendNotice(): (status: {
  readonly holding: boolean;
}) => boolean {
  let held = false;
  return ({ holding }) => {
    if (holding && !held)
      process.stderr.write("Queue holding for spend limit\n");
    held = holding;
    return holding;
  };
}
