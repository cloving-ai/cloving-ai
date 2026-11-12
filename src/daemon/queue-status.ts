import { send } from "../cli/client.ts";
import { runIdentity } from "../service/submission-handler.ts";
import { record, type Fields } from "../protocol.ts";

function queueBusy(value: unknown): number | undefined {
  const busy = record(value)?.["busy"];
  if (typeof busy !== "number") return undefined;
  if (!Number.isSafeInteger(busy) || busy < 0)
    throw new Error("invalid-queue-status");
  return busy;
}

function overviewStatus(result: Fields, workflowId: string) {
  const queues = result["queues"];
  const queue = Array.isArray(queues)
    ? queues.map(record).find((entry) => entry?.["workflowId"] === workflowId)
    : record(result["queue"]);
  const busy = queueBusy(queue);
  if (busy === undefined) return undefined;
  return {
    busy,
    repositoryBusy: Array.isArray(queues)
      ? queues.reduce(
          (total: number, entry: unknown) => total + (queueBusy(entry) ?? 0),
          0,
        )
      : busy,
    holding: record(queue?.["spend"])?.["holding"] === true,
  };
}

export async function queueStatus(settings: {
  readonly runtimeDirectory: string;
  readonly workflowId: string;
}): Promise<{
  readonly busy: number;
  readonly holding: boolean;
  readonly repositoryBusy: number;
}> {
  let count = 0;
  let after: string | null = "";
  do {
    const reply = await send(settings.runtimeDirectory, {
      operation: "status",
      parameters: { after, limit: 500 },
    });
    if (reply.kind === "error") throw new Error(reply.error.code);
    const status = overviewStatus(reply.result, settings.workflowId);
    if (status !== undefined) return status;
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
  return { busy: count, holding: false, repositoryBusy: count };
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

export async function runStatus(
  runtimeDirectory: string,
  commandId: string,
): Promise<Fields | undefined> {
  const reply = await send(runtimeDirectory, {
    operation: "status",
    parameters: { runId: runIdentity(commandId) },
  });
  if (reply.kind === "error" && reply.error.code === "unknown-run")
    return undefined;
  if (reply.kind === "error") throw new Error(reply.error.code);
  const run = record(reply.result["run"]);
  if (run === undefined) throw new Error("invalid-run-status");
  return run;
}

export async function trackedRuns(
  runtimeDirectory: string,
  commands: readonly string[],
): Promise<readonly { readonly commandId: string; readonly run: Fields }[]> {
  if (commands.length === 0) return [];
  if (commands.length === 1) {
    const commandId = String(commands[0]);
    const run = await runStatus(runtimeDirectory, commandId);
    if (run === undefined) throw new Error("queue-run-missing");
    return [{ commandId, run }];
  }
  const reply = await send(runtimeDirectory, {
    operation: "status",
    parameters: { runIds: commands.map(runIdentity) },
  });
  if (reply.kind === "error") throw new Error(reply.error.code);
  const runs = reply.result["runs"];
  if (!Array.isArray(runs)) throw new Error("invalid-run-list");
  return commands.map((commandId) => {
    const run = runs
      .map(record)
      .find((item) => item?.["runId"] === runIdentity(commandId));
    if (run === undefined) throw new Error("queue-run-missing");
    return { commandId, run };
  });
}
