import net from "node:net";
import { socketAddress } from "../broker/socket-address.ts";
import { parseReplyLine, requestLine } from "../protocol.ts";
import type { WorkspaceHold } from "../queue-room.ts";
import { permitHoldOf } from "../workspace-hold.ts";

export type Permit =
  | { readonly kind: "admitted"; readonly release: () => void }
  | { readonly kind: "held"; readonly hold: WorkspaceHold };

const unansweredPermit: Permit = {
  kind: "held",
  hold: {
    reason: "workspace-unknown",
    text: "Held: the workspace supervisor does not answer",
  },
};

const answerMilliseconds = 30_000;

function permitOf(line: string, release: () => void): Permit | undefined {
  const reply = parseReplyLine(line);
  if (reply?.kind !== "result") return undefined;
  if (reply.result["admitted"] === true) return { kind: "admitted", release };
  const hold = permitHoldOf(reply.result["hold"]);
  return hold === undefined ? undefined : { kind: "held", hold };
}

function asked(path: string): Promise<Permit> {
  return new Promise((settle) => {
    const socket = net.connect({ path });
    const held = (): void => {
      clearTimeout(timer);
      settle(unansweredPermit);
      socket.destroy();
    };
    const timer = setTimeout(held, answerMilliseconds);
    let buffered = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(requestLine({ operation: "permit", parameters: {} }));
    });
    socket.on("data", (chunk: string) => {
      buffered += chunk;
      const end = buffered.indexOf("\n");
      if (end < 0) return;
      clearTimeout(timer);
      const permit = permitOf(buffered.slice(0, end), () => {
        socket.end();
      });
      if (permit === undefined) held();
      else settle(permit);
    });
    socket.on("error", held);
    socket.on("close", held);
  });
}

export function workspacePermits(path: string): () => Promise<Permit> {
  const address = socketAddress(path);
  if (address.kind === "refused")
    return () => Promise.resolve(unansweredPermit);
  return () => asked(address.path);
}
