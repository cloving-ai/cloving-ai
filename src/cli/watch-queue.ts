import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { record, type Fields } from "../protocol.ts";
import { isRecordKey } from "../authority/commands.ts";
import { send } from "./client.ts";
import { queueSettingRequest } from "../queue-setting-operation.ts";
import {
  actionAllowed,
  actionBody,
  type WatchActions,
} from "./watch-actions.ts";

function laneAction(body: Fields): boolean {
  const lane = (value: unknown) =>
    Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 16;
  return (
    Object.keys(body).length === 5 &&
    typeof body["workflowId"] === "string" &&
    /^[A-Za-z0-9-]{1,64}$/.test(body["workflowId"]) &&
    isRecordKey(body["commandId"]) &&
    lane(body["lanes"]) &&
    lane(body["expectedLanes"])
  );
}

function queueRequest(body: Fields) {
  const command = body["command"];
  if (command === "lanes")
    return laneAction(body)
      ? {
          operation: "queue-lanes",
          parameters: {
            lanes: body["lanes"],
            expectedLanes: body["expectedLanes"],
            commandId: body["commandId"],
            workflowId: body["workflowId"],
          },
        }
      : undefined;
  if (command !== "drain" && command !== "resume") return undefined;
  return {
    operation: "queue-command",
    parameters: {
      command,
      commandId: body["commandId"] ?? randomUUID(),
      workflowId: body["workflowId"],
    },
  };
}

export async function queueAction(
  actions: WatchActions,
  request: IncomingMessage,
): Promise<string | null> {
  if (!actionAllowed(actions, request)) return null;
  const body = record(await actionBody(request));
  if (body === undefined) return null;
  const given = queueRequest(body);
  if (given === undefined) return null;
  const reply = await send(actions.runtimeDirectory, given);
  return JSON.stringify(
    reply.kind === "result" ? reply.result : { error: reply.error },
  );
}

export async function queueSettingsAction(
  actions: WatchActions,
  request: IncomingMessage,
): Promise<string | null> {
  if (!actionAllowed(actions, request)) return null;
  const body = queueSettingRequest(await actionBody(request));
  if (body === undefined) return null;
  const reply = await send(actions.runtimeDirectory, {
    operation: "queue-setting",
    parameters: { ...body },
  });
  return JSON.stringify(
    reply.kind === "result" ? reply.result : { error: reply.error },
  );
}

export function watchQueues(status: Fields) {
  const queue = record(status["queue"]);
  const queues = status["queues"];
  const globalQueue = record(status["globalQueue"]);
  return {
    ...(globalQueue === undefined ? {} : { globalQueue }),
    ...(queue === undefined ? {} : { queue }),
    ...(Array.isArray(queues)
      ? { queues: queues.map(record).filter((item) => item !== undefined) }
      : {}),
  };
}
