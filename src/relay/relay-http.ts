import http from "node:http";
import https from "node:https";

export interface RelayCall {
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly path: string;
  readonly token?: string;
  readonly body?: unknown;
  readonly timeoutMilliseconds?: number;
  readonly signal?: AbortSignal;
}

export interface RelayReply {
  readonly status: number;
  readonly body: unknown;
}

export function relayOrigin(value: string | undefined): string {
  const given = value ?? "https://cloving.ai";
  const url = URL.parse(given);
  const local = url?.protocol === "http:" && url.hostname === "127.0.0.1";
  if (
    url === null ||
    (url.protocol !== "https:" && !local) ||
    url.origin !== given
  )
    throw new Error(
      `relay-origin-invalid: CLOVING_RELAY_ORIGIN must be an https origin, such as https://cloving.ai.`,
    );
  return url.origin;
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function headers(call: RelayCall, payload: string | undefined) {
  return {
    accept: "application/json",
    ...(payload === undefined ? {} : { "content-type": "application/json" }),
    ...(call.token === undefined
      ? {}
      : { authorization: `Bearer ${call.token}` }),
  };
}

export function relayRequest(
  origin: string,
  call: RelayCall,
): Promise<RelayReply> {
  const url = new URL(call.path, origin);
  const transport = url.protocol === "https:" ? https : http;
  const payload =
    call.body === undefined ? undefined : JSON.stringify(call.body);
  return new Promise((settle, reject) => {
    const request = transport.request(
      url,
      {
        method: call.method,
        headers: headers(call, payload),
        timeout: call.timeoutMilliseconds ?? 30_000,
        ...(call.signal === undefined ? {} : { signal: call.signal }),
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          text += chunk;
        });
        response.once("end", () => {
          settle({ status: response.statusCode ?? 0, body: parsed(text) });
        });
      },
    );
    request.once("timeout", () => {
      request.destroy(new Error("relay-timeout: cloving.ai did not answer."));
    });
    request.once("error", reject);
    request.end(payload);
  });
}
