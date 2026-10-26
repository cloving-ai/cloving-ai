import { chmod, rm } from "node:fs/promises";
import net from "node:net";
import {
  maximumFrameBytes,
  parseRequest,
  replyLine,
  type Reply,
  type ServiceRequest,
} from "../protocol.ts";

export type PhoneHandler = (request: ServiceRequest) => Promise<Reply>;

export interface PhoneSocket {
  readonly close: () => Promise<void>;
}

function failed(error: unknown): Reply {
  return {
    kind: "error",
    error: {
      code: "phone-relay-failed",
      detail: String(Reflect.get(Object(error), "message")),
    },
  };
}

function served(socket: net.Socket, handle: PhoneHandler): void {
  let buffered = "";
  socket.setEncoding("utf8");
  socket.on("error", () => undefined);
  socket.on("data", (data: string) => {
    buffered += data;
    const end = buffered.indexOf("\n");
    if (end < 0 && Buffer.byteLength(buffered) <= maximumFrameBytes) return;
    socket.removeAllListeners("data");
    const parsed = parseRequest(end < 0 ? "" : buffered.slice(0, end));
    const answer = (reply: Reply): void => {
      socket.end(replyLine(reply));
    };
    const replied =
      parsed.kind === "error"
        ? Promise.resolve<Reply>(parsed)
        : handle(parsed.request);
    replied.then(answer, (error: unknown) => {
      answer(failed(error));
    });
  });
}

export async function listenPhoneSocket(
  path: string,
  handle: PhoneHandler,
): Promise<PhoneSocket> {
  await rm(path, { force: true });
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    served(socket, handle);
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
      const closed = new Promise<void>((settle) => {
        server.close(() => {
          settle();
        });
      });
      for (const socket of sockets) socket.destroy();
      await closed;
    },
  };
}
