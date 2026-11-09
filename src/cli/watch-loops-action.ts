import type { IncomingMessage } from "node:http";
import { isRecordKey } from "../authority/commands.ts";
import { record } from "../protocol.ts";
import { send } from "./client.ts";
import { scheduleServiceRequest } from "./schedule-arguments.ts";
import {
  actionAllowed,
  actionBody,
  type WatchActions,
} from "./watch-actions.ts";

const loopActions = ["pause", "resume", "run"] as const;

function loopAction(value: unknown): value is (typeof loopActions)[number] {
  return loopActions.some((action) => action === value);
}

export async function scheduleAction(
  actions: WatchActions,
  request: IncomingMessage,
): Promise<string | null> {
  if (!actionAllowed(actions, request)) return null;
  const body = record(await actionBody(request));
  if (body === undefined || Object.keys(body).length !== 3) return null;
  const { workflowId, action, commandId } = body;
  if (!isRecordKey(workflowId) || !isRecordKey(commandId)) return null;
  if (!loopAction(action)) return null;
  const reply = await send(
    actions.runtimeDirectory,
    scheduleServiceRequest(
      { kind: "schedule", action, workflowId, commandId, json: true },
      action === "run" ? commandId : null,
    ),
  );
  return JSON.stringify(
    reply.kind === "result" ? reply.result : { error: reply.error },
  );
}
