import type { Fields, Reply } from "../protocol.ts";
import { snapshot, viewOf } from "./run-handlers.ts";
import {
  committed,
  failed,
  invalidRequest,
  isIdentifier,
  publicReceipt,
  rejection,
  result,
  wholeNumber,
  type ServiceContext,
} from "./replies.ts";

const kinds: Readonly<Record<string, string>> = {
  pause: "pause-run",
  resume: "resume-run",
  drop: "cancel-run",
};

async function reported(
  context: ServiceContext,
  outcome: {
    readonly command: string;
    readonly commandId: string;
    readonly runId: string;
    readonly replayed: boolean;
  },
): Promise<Reply> {
  const { command, commandId, runId } = outcome;
  const stored = await context.authority.queries.receipt(commandId);
  const current = await snapshot(context);
  const view = await viewOf(context, { snapshot: current, runId });
  if (stored === undefined || view === undefined)
    return failed("authority-unavailable", { commandId, runId });
  const operations = current.operations.filter(
    (operation) => operation.runId === runId,
  );
  return result("run-command", {
    command,
    runId,
    commandId,
    replayed: outcome.replayed,
    receipt: publicReceipt(stored),
    committed: {
      state: view.state,
      revision: view.revision,
      revokedIntents: operations.filter(
        (operation) => operation.releasedSequence === stored.sequence,
      ).length,
    },
    observed: {
      condition: view.condition,
      unresolvedEffects: view.unresolvedEffects,
    },
  });
}

export async function runCommand(
  context: ServiceContext,
  parameters: Fields,
): Promise<Reply> {
  const { command, runId, expectedRevision, commandId } = parameters;
  if (
    typeof command !== "string" ||
    !Object.hasOwn(kinds, command) ||
    !isIdentifier(runId) ||
    !isIdentifier(commandId) ||
    !wholeNumber(expectedRevision, 1)
  )
    return invalidRequest("The run command request is not valid.");
  const receipt = await context.gateway.execute({
    principal: "operator",
    command: { kind: kinds[command], commandId, runId, expectedRevision },
  });
  if (!committed(receipt)) {
    const run = (await context.authority.state()).runs[runId];
    return rejection(receipt, {
      commandId,
      runId,
      currentRevision: run?.revision ?? null,
    });
  }
  return reported(context, {
    command,
    commandId,
    runId,
    replayed: receipt.kind === "duplicate",
  });
}
