import { chmod, rm } from "node:fs/promises";
import net from "node:net";
import {
  eventLine,
  maximumFrameBytes,
  parseRequest,
  replyLine,
  type Reply,
  type ServiceRequest,
} from "../protocol.ts";
import type { Connection } from "./event-handler.ts";

export type Handle = (
  request: ServiceRequest,
  connection: Connection,
) => Promise<Reply | undefined>;

export interface Listener {
  readonly close: () => Promise<void>;
}

function tooLarge(): Reply {
  return {
    kind: "error",
    error: {
      code: "request-too-large",
      detail: `A request has at most ${String(maximumFrameBytes)} bytes.`,
    },
  };
}

function unavailable(error: unknown): Reply {
  return {
    kind: "error",
    error: {
      code: "authority-unavailable",
      detail: String(Reflect.get(Object(error), "message")),
    },
  };
}

export interface ConnectionLimits {
  readonly idleMilliseconds: number;
}

function flushed(socket: net.Socket, limit: number): Promise<boolean> {
  return new Promise((settle) => {
    const settled = (outcome: "drained" | "stalled") => (): void => {
      clearTimeout(timer);
      socket.off("drain", onDrain);
      socket.off("close", onStall);
      if (outcome === "stalled") socket.destroy();
      settle(outcome === "drained");
    };
    const onDrain = settled("drained");
    const onStall = settled("stalled");
    const timer = setTimeout(onStall, limit);
    socket.once("drain", onDrain);
    socket.once("close", onStall);
  });
}

function served(
  socket: net.Socket,
  serving: { readonly handle: Handle; readonly limits: ConnectionLimits },
): void {
  const { handle, limits } = serving;
  let buffered = "";
  let handled = false;
  const connection: Connection = {
    send: (events) => {
      if (socket.destroyed) return Promise.resolve(false);
      const written = events.map((event) => socket.write(eventLine(event)));
      return written.includes(false)
        ? flushed(socket, limits.idleMilliseconds)
        : Promise.resolve(true);
    },
    closed: () => socket.destroyed || socket.readableEnded,
  };
  socket.setTimeout(limits.idleMilliseconds, () => {
    if (!handled) socket.destroy();
  });
  const finish = (reply: Reply | undefined): void => {
    if (socket.destroyed) return;
    if (reply === undefined) socket.destroy();
    else socket.end(replyLine(reply));
    setTimeout(() => socket.destroy(), limits.idleMilliseconds).unref();
  };
  socket.setEncoding("utf8");
  socket.on("error", () => undefined);
  socket.on("data", (data: string) => {
    if (handled) return;
    buffered += data;
    const end = buffered.indexOf("\n");
    if (end < 0 && Buffer.byteLength(buffered) <= maximumFrameBytes) return;
    handled = true;
    if (end < 0 || end > maximumFrameBytes) {
      finish(tooLarge());
      return;
    }
    const parsed = parseRequest(buffered.slice(0, end));
    if (parsed.kind === "error") {
      finish(parsed);
      return;
    }
    Promise.resolve(parsed.request)
      .then((request) => handle(request, connection))
      .then(finish, (error: unknown) => {
        finish(unavailable(error));
      });
  });
  socket.on("end", () => {
    if (!handled) socket.end();
  });
}

export const connectionLimits: ConnectionLimits = {
  idleMilliseconds: 30_000,
};

export async function listen(options: {
  readonly path: string;
  readonly handle: Handle;
  readonly limits?: ConnectionLimits;
}): Promise<Listener> {
  const { path, handle } = options;
  const limits = options.limits ?? connectionLimits;
  const sockets = new Set<net.Socket>();
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    served(socket, { handle, limits });
  });
  await new Promise<void>((ready, refuse) => {
    server.once("error", refuse);
    server.listen(path, () => {
      server.off("error", refuse);
      ready();
    });
  });
  await chmod(path, 0o600);
  return {
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((closed) => {
        server.close(() => {
          closed();
        });
      });
      await rm(path, { force: true });
    },
  };
}

export function reachable(path: string): Promise<boolean> {
  return new Promise((settle) => {
    const socket = net.connect(path);
    socket.on("connect", () => {
      socket.destroy();
      settle(true);
    });
    socket.on("error", () => {
      settle(false);
    });
  });
}
