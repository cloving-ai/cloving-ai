import { isCommandId } from "../authority/commands.ts";
import { noteLimit, noteText } from "../authority/notes.ts";
import type { RunRecord } from "../broker/actor/authority-queries.ts";
import { operationDigest } from "../broker/operation-digest.ts";
import type { Fields, Reply } from "../protocol.ts";
import {
  committed,
  failed,
  invalidRequest,
  isIdentifier,
  publicReceipt,
  rejection,
  result,
  type ServiceContext,
} from "./replies.ts";

interface Identity {
  readonly runId: string;
  readonly commandId: string;
}

interface SteerRequest extends Identity {
  readonly note: string;
  readonly now: boolean;
}

function invalidNote(identity: Identity): Reply {
  return failed("invalid-note", {
    ...identity,
    detail: `A note has 1 to ${String(noteLimit)} characters after the spaces at its start and end are removed.`,
  });
}

async function replayedNote(
  context: ServiceContext,
  request: SteerRequest,
): Promise<Reply | undefined> {
  const { runId, commandId, note } = request;
  const existing = await context.authority.queries.receipt(commandId);
  if (existing === undefined) return undefined;
  const { command } = existing;
  if (
    command.kind !== "note-run" ||
    command.runId !== runId ||
    command.note !== note
  )
    return failed("conflicting-command", {
      commandId,
      detail: "The command ID is known with a different request.",
    });
  return result("run-noted", {
    runId,
    commandId,
    noteId: command.noteId,
    replayed: true,
    receipt: publicReceipt(existing),
  });
}

function runRefusal(
  run: RunRecord | undefined,
  identity: Identity,
): Reply | undefined {
  if (run === undefined)
    return failed("unknown-run", {
      ...identity,
      detail: `No run has the ID ${identity.runId}.`,
    });
  if (run.status === "cancelled")
    return failed("run-cancelled", {
      ...identity,
      detail: "A person dropped the run. A dropped run takes no notes.",
    });
  if (run.status === "completed" || run.status === "failed")
    return failed("run-not-active", {
      ...identity,
      detail: "The run ended. Only an active run takes a note.",
    });
  return undefined;
}

async function delivery(
  context: ServiceContext,
  request: SteerRequest & { readonly noteId: string },
): Promise<Fields> {
  if (!request.now) return { delivery: "queued" };
  const steering = context.turnSteering;
  if (steering === undefined)
    return { delivery: "queued", reason: "no-open-turn" };
  return {
    ...(await steering.steer({
      runId: request.runId,
      noteId: request.noteId,
      text: request.note,
    })),
  };
}

export async function steerRun(
  context: ServiceContext,
  parameters: Fields,
): Promise<Reply> {
  const { runId, commandId } = parameters;
  const now = parameters["now"] ?? false;
  if (
    !isIdentifier(runId) ||
    !isCommandId(commandId) ||
    typeof now !== "boolean"
  )
    return invalidRequest("The steer request is not valid.");
  const note = noteText(parameters["note"]);
  if (note === undefined) return invalidNote({ runId, commandId });
  const request = { runId, commandId, note, now };
  const replayed = await replayedNote(context, request);
  if (replayed !== undefined) return replayed;
  const refused = runRefusal(
    await context.authority.queries.run(runId),
    request,
  );
  if (refused !== undefined) return refused;
  const noteId = `note-${operationDigest(commandId).slice(0, 32)}`;
  const receipt = await context.gateway.execute({
    principal: "operator",
    command: {
      kind: "note-run",
      commandId,
      runId,
      noteId,
      note,
      source: "steer",
    },
  });
  if (!committed(receipt)) return rejection(receipt, { commandId, runId });
  const stored = await context.authority.queries.receipt(commandId);
  if (stored === undefined)
    return failed("authority-unavailable", { commandId, runId });
  return result("run-noted", {
    runId,
    commandId,
    noteId,
    ...(await delivery(context, { ...request, noteId })),
    replayed: receipt.kind === "duplicate",
    receipt: publicReceipt(stored),
  });
}
