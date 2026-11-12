import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { record, type Fields } from "../protocol.ts";
import { send } from "./client.ts";
import {
  actionAllowed,
  actionBody,
  type WatchActions,
} from "./watch-actions.ts";

export async function queueAction(
  actions: WatchActions,
  request: IncomingMessage,
): Promise<string | null> {
  if (!actionAllowed(actions, request)) return null;
  const body = record(await actionBody(request));
  if (body === undefined) return null;
  const command = body["command"];
  if (command !== "drain" && command !== "resume" && command !== "lanes")
    return null;
  const reply = await send(actions.runtimeDirectory, {
    operation: command === "lanes" ? "queue-lanes" : "queue-command",
    parameters: {
      ...(command === "lanes"
        ? { lanes: body["lanes"], expectedLanes: body["expectedLanes"] }
        : { command }),
      commandId: body["commandId"] ?? randomUUID(),
      workflowId: body["workflowId"],
    },
  });
  return JSON.stringify(
    reply.kind === "result" ? reply.result : { error: reply.error },
  );
}

export function watchQueues(status: Fields) {
  const queue = record(status["queue"]);
  const queues = status["queues"];
  return {
    ...(queue === undefined ? {} : { queue }),
    ...(Array.isArray(queues)
      ? { queues: queues.map(record).filter((item) => item !== undefined) }
      : {}),
  };
}
