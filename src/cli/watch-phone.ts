import type { IncomingMessage } from "node:http";
import { qrMatrix } from "../phone/qr-matrix.ts";
import { qrPicture } from "../phone/qr-picture.ts";
import type { Fields } from "../protocol.ts";
import { phoneRequest } from "./phone-client.ts";
import {
  actionAllowed,
  actionBody,
  type WatchActions,
} from "./watch-actions.ts";

const operations: Readonly<Record<string, string>> = {
  "/actions/phone/pair": "phone-pair-start",
  "/actions/phone/cancel": "phone-pair-cancel",
  "/actions/phone/accept": "phone-pair-accept",
  "/actions/phone/deny": "phone-pair-deny",
  "/actions/phone/remove": "phone-remove",
};

export function isPhoneAction(path: string): boolean {
  return Object.hasOwn(operations, path);
}

function withPicture(result: Fields): Fields {
  const link = result["link"];
  return typeof link === "string"
    ? { ...result, picture: qrPicture(qrMatrix(link).modules) }
    : result;
}

export async function phoneAction(
  actions: WatchActions,
  request: IncomingMessage,
): Promise<string | null> {
  const operation =
    operations[new URL(String(request.url), "http://localhost").pathname];
  if (operation === undefined || !actionAllowed(actions, request)) return null;
  const body = await actionBody(request);
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return null;
  const reply = await phoneRequest(actions.runtimeDirectory, {
    operation,
    parameters: { ...body },
  });
  if (reply === undefined)
    return JSON.stringify({
      error: {
        code: "phone-relay-off",
        detail: "The phone relay is off or not started.",
      },
    });
  return JSON.stringify(
    reply.kind === "result"
      ? withPicture(reply.result)
      : { error: reply.error },
  );
}

export async function phoneRead(runtimeDirectory: string): Promise<string> {
  const reply = await phoneRequest(runtimeDirectory, {
    operation: "phone-state",
    parameters: {},
  });
  if (reply === undefined) return JSON.stringify({ relay: "off" });
  return JSON.stringify(
    reply.kind === "result"
      ? { relay: "on", ...reply.result }
      : { relay: "on", error: reply.error },
  );
}
