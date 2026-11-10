import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { isRecordKey } from "../authority/commands.ts";
import { record, type Fields } from "../protocol.ts";
import { send } from "./client.ts";
import { runCommandRequest } from "./command-requests.ts";
import type { RunCommand } from "./runtime-invocation.ts";
import {
  actionAllowed,
  actionBody,
  type WatchActions,
} from "./watch-actions.ts";

type RunAction = (
  actions: WatchActions,
  request: IncomingMessage,
) => Promise<string | null>;

type Operation = "continue-run" | "dismiss-run" | "steer-run";

const allowedNotes: Readonly<Record<Operation, (note: unknown) => boolean>> = {
  "continue-run": (note) => note === undefined || typeof note === "string",
  "dismiss-run": (note) => note === undefined,
  "steer-run": (note) => typeof note === "string",
};

function bodyFields(operation: Operation, body: Fields): Fields | null {
  const { runId, note } = body;
  const now = body["now"] ?? false;
  if (!isRecordKey(runId) || !allowedNotes[operation](note)) return null;
  if (operation !== "steer-run")
    return note === undefined ? { runId } : { runId, note };
  return typeof now === "boolean" ? { runId, note, now } : null;
}

function runAction(operation: Operation): RunAction {
  return async (actions, request) => {
    if (!actionAllowed(actions, request)) return null;
    const fields = bodyFields(
      operation,
      record(await actionBody(request)) ?? {},
    );
    if (fields === null) return null;
    const reply = await send(actions.runtimeDirectory, {
      operation,
      parameters: { ...fields, commandId: randomUUID() },
    });
    return JSON.stringify(
      reply.kind === "result" ? reply.result : { error: reply.error },
    );
  };
}

function commandFields(body: Fields | undefined): Fields | null {
  if (body === undefined || Object.keys(body).length !== 3) return null;
  const { runId, expectedRevision, commandId } = body;
  if (!isRecordKey(runId) || !isRecordKey(commandId)) return null;
  if (!Number.isSafeInteger(expectedRevision)) return null;
  return Number(expectedRevision) >= 1
    ? { runId, expectedRevision, commandId }
    : null;
}

function commandAction(command: RunCommand): RunAction {
  return async (actions, request) => {
    if (!actionAllowed(actions, request)) return null;
    const fields = commandFields(record(await actionBody(request)));
    if (fields === null) return null;
    const reply = await send(
      actions.runtimeDirectory,
      runCommandRequest({
        command,
        runId: String(fields["runId"]),
        expectedRevision: Number(fields["expectedRevision"]),
        commandId: String(fields["commandId"]),
      }),
    );
    return JSON.stringify(
      reply.kind === "result" ? reply.result : { error: reply.error },
    );
  };
}

const runActions: Readonly<Record<string, RunAction>> = {
  "/actions/continue": runAction("continue-run"),
  "/actions/dismiss": runAction("dismiss-run"),
  "/actions/drop": commandAction("drop"),
  "/actions/pause": commandAction("pause"),
  "/actions/resume": commandAction("resume"),
  "/actions/steer": runAction("steer-run"),
};

export function routedRunAction(path: string): RunAction | null {
  return Object.hasOwn(runActions, path) ? (runActions[path] ?? null) : null;
}
