import type { Fields, Reply } from "../protocol.ts";
import {
  failed,
  invalidRequest,
  isIdentifier,
  result,
  type ServiceContext,
} from "./replies.ts";

export async function queueRunStatuses(
  context: ServiceContext,
  runIds: unknown,
): Promise<Reply> {
  if (
    !Array.isArray(runIds) ||
    runIds.length === 0 ||
    runIds.length > 4 ||
    !runIds.every(isIdentifier)
  )
    return invalidRequest("A queue status batch needs one to four run IDs.");
  const state = await context.authority.state();
  const runs: Fields[] = [];
  for (const runId of runIds) {
    const run = state.runs[runId];
    if (run === undefined)
      return failed("unknown-run", { detail: `No run has the ID ${runId}.` });
    runs.push(
      await queuedRun(context, {
        runId,
        status: run.status,
        sequence: state.sequence,
      }),
    );
  }
  return result("queue-run-statuses", { runs });
}

async function queuedRun(
  context: ServiceContext,
  run: {
    readonly runId: string;
    readonly status: string;
    readonly sequence: number;
  },
): Promise<Fields> {
  const event = await context.authority.queries.latestCompletion({
    runId: run.runId,
    atOrBefore: run.sequence,
    terminal: true,
  });
  return {
    runId: run.runId,
    state: run.status,
    terminalSequence: event?.sequence ?? null,
    outcome:
      event?.type === "run.completed"
        ? {
            kind: event.payload["outcome"],
            issueUpdate: event.payload["issueUpdate"],
          }
        : null,
  };
}
