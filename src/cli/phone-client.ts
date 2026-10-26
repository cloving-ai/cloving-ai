import net from "node:net";
import { join } from "node:path";
import { socketAddress } from "../broker/socket-address.ts";
import {
  parseReplyLine,
  requestLine,
  type Reply,
  type ServiceRequest,
} from "../protocol.ts";

const absent = ["ENOENT", "ECONNREFUSED"];

export function phoneRequest(
  runtimeDirectory: string,
  request: ServiceRequest,
): Promise<Reply | undefined> {
  const address = socketAddress(join(runtimeDirectory, "phone.sock"));
  if (address.kind === "refused")
    return Promise.resolve({
      kind: "error",
      error: { code: address.reason, detail: address.detail },
    });
  return new Promise((settle, reject) => {
    const socket = net.connect(address.path);
    let buffered = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(requestLine(request)));
    socket.on("data", (data: string) => {
      buffered += data;
    });
    socket.once("end", () => {
      const parsed = parseReplyLine(buffered.trim());
      settle(parsed?.kind === "event" ? undefined : parsed);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (absent.includes(error.code ?? "")) settle(undefined);
      else reject(error);
    });
  });
}
