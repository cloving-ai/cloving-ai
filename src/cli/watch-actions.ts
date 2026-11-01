import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { send } from "./client.ts";
import { watchCardForms } from "./watch-card-forms.ts";
import { dirname, join } from "node:path";
import { cardRunRequest, type CardForm } from "./watch-run-input.ts";

export interface WatchActions {
  readonly forms: readonly CardForm[];
  readonly token: string;
  readonly runtimeDirectory: string;
}

export async function watchActions(
  runtimeDirectory: string,
): Promise<WatchActions> {
  return {
    runtimeDirectory,
    forms: await watchCardForms(join(dirname(runtimeDirectory), "project")),
    token: randomBytes(32).toString("hex"),
  };
}

export function watchHost(request: IncomingMessage): boolean {
  const port = request.socket.localPort;
  return [`127.0.0.1:${String(port)}`, `localhost:${String(port)}`].includes(
    request.headers.host ?? "",
  );
}

export function actionAllowed(
  actions: WatchActions,
  request: IncomingMessage,
): boolean {
  return (
    watchHost(request) &&
    request.headers.origin === `http://${request.headers.host ?? ""}` &&
    request.headers["x-cloving-token"] === actions.token &&
    /^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
      request.headers["content-type"] ?? "",
    )
  );
}

export async function actionBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += bytes.length;
    if (size > 16384) return null;
    chunks.push(bytes);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return value;
  } catch {
    return null;
  }
}

export async function watchAction(
  actions: WatchActions,
  request: IncomingMessage,
): Promise<string | null> {
  if (!actionAllowed(actions, request)) return null;
  const given = cardRunRequest(actions.forms, await actionBody(request));
  if (given === null) return null;
  const status = await send(actions.runtimeDirectory, {
    operation: "status",
    parameters: {},
  });
  if (status.kind === "error") return JSON.stringify(status);
  const workflows = status.result["workflows"];
  if (
    !Array.isArray(workflows) ||
    !workflows.includes(given.parameters["workflowId"])
  )
    return null;
  return JSON.stringify(await send(actions.runtimeDirectory, given));
}
