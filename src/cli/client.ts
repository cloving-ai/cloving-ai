import net from "node:net";
import { join } from "node:path";
import { socketAddress } from "../broker/socket-address.ts";
import {
  parseReplyLine,
  requestLine,
  type Fields,
  type Reply,
  type ServiceRequest,
} from "../protocol.ts";

const mutations = ["run", "decision", "run-command"];

function unavailable(runtimeDirectory: string): Reply {
  return {
    kind: "error",
    error: {
      code: "service-unavailable",
      detail: `No Cloving service answers in ${runtimeDirectory}. Start the service, or set CLOVING_RUNTIME_DIR to its runtime directory.`,
    },
  };
}

function refused(runtimeDirectory: string): Reply {
  return {
    kind: "error",
    error: {
      code: "permission-denied",
      detail: `The service socket in ${runtimeDirectory} refused this account.`,
    },
  };
}

function lost(request: ServiceRequest, runtimeDirectory: string): Reply {
  if (!mutations.includes(request.operation))
    return unavailable(runtimeDirectory);
  return {
    kind: "error",
    error: {
      code: "outcome-unknown",
      detail:
        "The connection ended before the reply. Send the command again with the same command ID.",
    },
  };
}

export interface Interruption {
  readonly signal: Promise<void>;
  readonly reply: Reply;
}

interface Exchange {
  readonly runtimeDirectory: string;
  readonly request: ServiceRequest;
  readonly onEvent: (event: Fields) => void;
  readonly interruption?: Interruption;
}

function exchange(context: Exchange): Promise<Reply> {
  const { runtimeDirectory, request, onEvent, interruption } = context;
  const address = socketAddress(join(runtimeDirectory, "control.sock"));
  if (address.kind === "refused")
    return Promise.resolve({
      kind: "error",
      error: { code: address.reason, detail: address.detail },
    });
  return new Promise((settle) => {
    const socket = net.connect(address.path);
    let buffered = "";
    let written = false;
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(requestLine(request), () => {
        written = true;
      });
    });
    socket.on("data", (data: string) => {
      buffered += data;
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        const parsed = parseReplyLine(line);
        if (parsed?.kind === "event") onEvent(parsed.event);
        if (parsed?.kind === "result" || parsed?.kind === "error") {
          settle(parsed);
          socket.destroy();
        }
      }
    });
    const stopped = (reply: Reply) => (): void => {
      settle(reply);
      socket.destroy();
    };
    if (interruption !== undefined)
      interruption.signal.then(
        stopped(interruption.reply),
        stopped(interruption.reply),
      );
    const ended = (code: unknown): Reply => {
      if (code === "EACCES") return refused(runtimeDirectory);
      return written
        ? lost(request, runtimeDirectory)
        : unavailable(runtimeDirectory);
    };
    socket.on("error", (error) => {
      settle(ended(Reflect.get(error, "code")));
    });
    socket.on("close", () => {
      settle(ended(undefined));
    });
  });
}

const unobserved = (): undefined => undefined;

export function send(
  runtimeDirectory: string,
  request: ServiceRequest,
): Promise<Reply> {
  return exchange({ runtimeDirectory, request, onEvent: unobserved });
}

function listedRuns(result: Fields): unknown[] {
  const runs = result["runs"];
  return Array.isArray(runs) ? runs.map((run: unknown) => run) : [];
}

export async function listRuns(runtimeDirectory: string): Promise<Reply> {
  const first = await send(runtimeDirectory, {
    operation: "status",
    parameters: { limit: 500 },
  });
  if (first.kind === "error") return first;
  const runs = listedRuns(first.result);
  let next = first.result["next"];
  let after = "";
  while (typeof next === "string") {
    if (next <= after)
      return {
        kind: "error",
        error: {
          code: "invalid-run-page",
          detail: "The run-list cursor did not advance.",
        },
      };
    after = next;
    const page = await send(runtimeDirectory, {
      operation: "status",
      parameters: { limit: 500, after },
    });
    if (page.kind === "error") return page;
    runs.push(...listedRuns(page.result));
    next = page.result["next"];
  }
  return { kind: "result", result: { ...first.result, runs, next: null } };
}

export function mutate(
  runtimeDirectory: string,
  mutation: {
    readonly request: ServiceRequest;
    readonly signal: Promise<void>;
  },
): Promise<Reply> {
  return exchange({
    runtimeDirectory,
    request: mutation.request,
    onEvent: unobserved,
    interruption: {
      signal: mutation.signal,
      reply: {
        kind: "error",
        error: {
          code: "outcome-unknown",
          detail:
            "A signal ended the command before the reply. Send the command again with the same command ID.",
        },
      },
    },
  });
}

export function follow(
  runtimeDirectory: string,
  stream: {
    readonly request: ServiceRequest;
    readonly onEvent: (event: Fields) => void;
    readonly signal: Promise<void>;
  },
): Promise<Reply> {
  return exchange({
    runtimeDirectory,
    request: stream.request,
    onEvent: stream.onEvent,
    interruption: {
      signal: stream.signal,
      reply: {
        kind: "result",
        result: { schemaVersion: 1, kind: "event-page", events: [] },
      },
    },
  });
}
