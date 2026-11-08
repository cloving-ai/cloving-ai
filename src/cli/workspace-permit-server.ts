import { chmod, rm } from "node:fs/promises";
import net from "node:net";
import { socketAddress } from "../broker/socket-address.ts";
import {
  maximumFrameBytes,
  parseRequest,
  record,
  replyLine,
  type Reply,
} from "../protocol.ts";
import { workspaceHold, type MemberReading } from "../workspace-hold.ts";
import type { WorkspaceLimits } from "../workspace.ts";
import { send } from "./client.ts";
import type { WorkspaceMember } from "./workspace-record.ts";

export interface PermitServer {
  readonly path: string;
  readonly close: () => Promise<void>;
}

export interface PermitSettings {
  readonly path: string;
  readonly members: () => readonly WorkspaceMember[];
  readonly limits: WorkspaceLimits;
}

const readMilliseconds = 10_000;

function movedFolder(error: unknown): void {
  if (!(error instanceof Error && "code" in error && error.code === "ENOTDIR"))
    throw error;
}

function unknownMember(member: WorkspaceMember, detail: string): MemberReading {
  return { kind: "unknown", name: member.name, detail };
}

async function busyOf(member: WorkspaceMember): Promise<number | string> {
  const reply = await send(member.runtime, {
    operation: "queue",
    parameters: {},
    signal: AbortSignal.timeout(readMilliseconds),
  });
  if (reply.kind === "error")
    return reply.error.code === "queue-unavailable" ? 0 : reply.error.code;
  const busy = record(reply.result["queue"])?.["busy"];
  return typeof busy === "number" ? busy : "invalid-queue-status";
}

async function spentOf(
  member: WorkspaceMember,
  limits: WorkspaceLimits,
): Promise<number | string> {
  if (limits.dailySpendLimitUsd === undefined) return 0;
  const reply = await send(member.runtime, {
    operation: "spend",
    parameters: {},
    signal: AbortSignal.timeout(readMilliseconds),
  });
  if (reply.kind === "error") return reply.error.code;
  const spent = reply.result["spentUsd"];
  return typeof spent === "number" ? spent : 0;
}

async function reading(
  member: WorkspaceMember,
  limits: WorkspaceLimits,
): Promise<MemberReading> {
  const busy = await busyOf(member);
  if (typeof busy === "string") return unknownMember(member, busy);
  const spentUsd = await spentOf(member, limits);
  if (typeof spentUsd === "string") return unknownMember(member, spentUsd);
  return { kind: "read", name: member.name, busy, spentUsd };
}

function invalid(detail: string): Reply {
  return { kind: "error", error: { code: "invalid-request", detail } };
}

async function answer(
  settings: PermitSettings,
  input: { readonly line: string; readonly permits: number },
): Promise<Reply> {
  const parsed = parseRequest(input.line);
  if (parsed.kind === "error") return parsed;
  if (parsed.request.operation !== "permit")
    return invalid("The workspace supervisor answers only permit requests.");
  const { limits } = settings;
  const members =
    limits.lanes === undefined && limits.dailySpendLimitUsd === undefined
      ? []
      : await Promise.all(
          settings.members().map((member) => reading(member, limits)),
        );
  const hold = workspaceHold(limits, { members, permits: input.permits });
  return {
    kind: "result",
    result: {
      kind: "workspace-permit",
      admitted: hold === undefined,
      ...(hold === undefined ? {} : { hold }),
    },
  };
}

interface Serving {
  readonly settings: PermitSettings;
  readonly sockets: Set<net.Socket>;
  permits: number;
  turn: Promise<void>;
}

function asked(
  serving: Serving,
  request: { readonly socket: net.Socket; readonly line: string },
): void {
  const { socket, line } = request;
  serving.turn = serving.turn.then(async () => {
    const reply = await answer(serving.settings, {
      line,
      permits: serving.permits,
    }).catch((error: unknown) =>
      invalid(error instanceof Error ? error.message : String(error)),
    );
    if (socket.destroyed) return;
    if (reply.kind === "result" && reply.result["admitted"] === true) {
      serving.permits += 1;
      socket.once("close", () => {
        serving.permits -= 1;
      });
    }
    socket.write(replyLine(reply));
  });
}

function served(serving: Serving, socket: net.Socket): void {
  let buffered = "";
  serving.sockets.add(socket);
  socket.setEncoding("utf8");
  socket.on("error", () => undefined);
  socket.on("close", () => {
    serving.sockets.delete(socket);
  });
  const reader = (chunk: string): void => {
    buffered += chunk;
    const end = buffered.indexOf("\n");
    if (end < 0 && Buffer.byteLength(buffered) <= maximumFrameBytes) return;
    socket.off("data", reader);
    if (end < 0) socket.destroy();
    else asked(serving, { socket, line: buffered.slice(0, end) });
  };
  socket.on("data", reader);
}

export async function permitServer(
  settings: PermitSettings,
): Promise<PermitServer> {
  const address = socketAddress(settings.path);
  if (address.kind === "refused")
    throw new Error(`${address.reason}: ${address.detail}`);
  const serving: Serving = {
    settings,
    sockets: new Set(),
    permits: 0,
    turn: Promise.resolve(),
  };
  await rm(address.path, { force: true });
  const server = net.createServer((socket) => {
    served(serving, socket);
  });
  await new Promise<void>((ready, refuse) => {
    server.once("error", refuse);
    server.listen(address.path, () => {
      server.off("error", refuse);
      ready();
    });
  });
  await chmod(address.path, 0o600);
  return {
    path: settings.path,
    close: async () => {
      const closed = new Promise<void>((settle) => {
        server.close(() => {
          settle();
        });
      });
      for (const socket of serving.sockets) socket.destroy();
      await closed;
      await rm(address.path, { force: true }).catch(movedFolder);
    },
  };
}
