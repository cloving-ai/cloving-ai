import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { isRecordKey } from "../authority/commands.ts";
import { record } from "../protocol.ts";
import { send } from "./client.ts";
import {
  actionAllowed,
  actionBody,
  type WatchActions,
} from "./watch-actions.ts";

type RunAction = (
  actions: WatchActions,
  request: IncomingMessage,
) => Promise<string | null>;

function runAction(operation: "continue-run" | "dismiss-run"): RunAction {
  return async (actions, request) => {
    if (!actionAllowed(actions, request)) return null;
    const runId = record(await actionBody(request))?.["runId"];
    if (!isRecordKey(runId)) return null;
    const reply = await send(actions.runtimeDirectory, {
      operation,
      parameters: { runId, commandId: randomUUID() },
    });
    return JSON.stringify(
      reply.kind === "result" ? reply.result : { error: reply.error },
    );
  };
}

export const continueAction = runAction("continue-run");

export const dismissAction = runAction("dismiss-run");
