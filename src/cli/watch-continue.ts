import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { isRecordKey } from "../authority/commands.ts";
import { record, type Fields } from "../protocol.ts";
import { send } from "./client.ts";
import { commandJson } from "./command-requests.ts";
import { mcpToolCall } from "./mcp-tools.ts";
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

const decisionCommands = new Set(["answer", "approve", "deny"]);

function pageText(text: unknown): boolean {
  if (text === undefined) return true;
  if (typeof text !== "string") return false;
  const size = Array.from(text.trim()).length;
  return size >= 1 && size <= 4000;
}

const decisionAction: RunAction = async (actions, request) => {
  if (!actionAllowed(actions, request)) return null;
  const { command, ...values } = record(await actionBody(request)) ?? {};
  if (typeof command !== "string" || !decisionCommands.has(command))
    return null;
  if (!pageText(values["text"])) return null;
  const call = mcpToolCall({ name: `cloving_${command}`, arguments: values });
  if (call?.kind !== "mutation") return null;
  const reply = await send(actions.runtimeDirectory, call.request);
  return JSON.stringify(commandJson(reply, { commandId: call.commandId }));
};

const runActions: Readonly<Record<string, RunAction>> = {
  "/actions/continue": runAction("continue-run"),
  "/actions/decision": decisionAction,
  "/actions/dismiss": runAction("dismiss-run"),
  "/actions/steer": runAction("steer-run"),
};

export function routedRunAction(path: string): RunAction | null {
  return Object.hasOwn(runActions, path) ? (runActions[path] ?? null) : null;
}
