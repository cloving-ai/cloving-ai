import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { record } from "../protocol.ts";
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
  const command = record(await actionBody(request))?.["command"];
  if (command !== "drain" && command !== "resume") return null;
  const reply = await send(actions.runtimeDirectory, {
    operation: "queue-command",
    parameters: { command, commandId: randomUUID() },
  });
  return JSON.stringify(
    reply.kind === "result" ? reply.result : { error: reply.error },
  );
}
