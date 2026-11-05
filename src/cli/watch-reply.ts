import type { IncomingMessage, ServerResponse } from "node:http";
import { watchApiTimeout } from "./watch-api.ts";
import type { WatchStream } from "./watch-stream.ts";

export const defaultReplyMilliseconds = 10_000;

export interface Reply {
  readonly status: number;
  readonly type: string;
  readonly body: string | Uint8Array;
  readonly cache?: string;
  readonly allow?: string;
  readonly policy?: string;
}

export const notFound: Reply = {
  status: 404,
  type: "text/plain",
  body: "not found",
};
const timeout: Reply = { status: 503, type: "text/plain", body: "timeout" };

function route(request: IncomingMessage): string {
  return String(request.url).replace(/\?.*$/s, "");
}

export function deadlined<Answer>(
  answer: Promise<Answer>,
  deadline: {
    readonly request: IncomingMessage;
    readonly milliseconds: number;
    readonly complain: (text: string) => void;
  },
): Promise<Answer | Reply> {
  const started = performance.now();
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<Reply>((settle) => {
    timer = setTimeout(() => {
      const elapsed = Math.round(performance.now() - started);
      const path = route(deadline.request);
      deadline.complain(
        `watch-reply-timeout path=${path} ms=${String(elapsed)}\n`,
      );
      settle(watchApiTimeout(path) ?? timeout);
    }, deadline.milliseconds);
  });
  return Promise.race([answer, expired]).finally(() => {
    clearTimeout(timer);
  });
}

export function replied(response: ServerResponse, reply: Reply): void {
  response.writeHead(reply.status, {
    "content-type": reply.type,
    "cache-control": reply.cache ?? "no-store",
    ...(reply.allow === undefined ? {} : { allow: reply.allow }),
    ...(reply.policy === undefined
      ? {}
      : {
          "content-security-policy": reply.policy,
          "x-content-type-options": "nosniff",
        }),
  });
  response.end(reply.body);
}

export function subscribed(
  stream: WatchStream,
  exchange: {
    readonly request: IncomingMessage;
    readonly response: ServerResponse;
    readonly message: () => string;
  },
): void {
  const { request, response, message } = exchange;
  const changed = (): void => {
    response.write(message());
  };
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
  });
  changed();
  request.once("close", stream.subscribe(changed));
}
