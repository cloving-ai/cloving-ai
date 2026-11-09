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
import type { WorkspaceHold } from "../queue-room.ts";
import { workspaceHold, type MemberReading } from "../workspace-hold.ts";
import type { WorkspaceLimits } from "../workspace.ts";
import { send } from "./client.ts";
import type { WorkspaceMember } from "./workspace-record.ts";
import {
  workspaceRestart,
  type WorkspaceRestart,
} from "./workspace-restart.ts";

export interface PermitServer {
  readonly path: string;
  readonly close: () => Promise<void>;
}

export interface PermitSettings {
  readonly path: string;
  readonly members: () => readonly WorkspaceMember[];
  readonly limits: WorkspaceLimits;
  readonly gapMilliseconds?: number;
  readonly answerMilliseconds?: number;
}

const readMilliseconds = 10_000;

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

function memberReadings(serving: Serving): Promise<readonly MemberReading[]> {
  const { limits } = serving.settings;
  if (
    serving.restart.hold() !== undefined ||
    (limits.lanes === undefined && limits.dailySpendLimitUsd === undefined)
  )
    return Promise.resolve([]);
  return Promise.all(
    serving.settings.members().map((member) => reading(member, limits)),
  );
}

function permitReply(hold: WorkspaceHold | undefined): Reply {
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
  readonly restart: WorkspaceRestart;
  permits: number;
  turn: Promise<void>;
}

function permitted(serving: Serving, socket: net.Socket): void {
  serving.turn = serving.turn.then(async () => {
    const members = await memberReadings(serving);
    if (socket.destroyed) return;
    const hold =
      serving.restart.hold() ??
      workspaceHold(serving.settings.limits, {
        members,
        permits: serving.permits,
      });
    if (hold !== undefined) {
      socket.end(replyLine(permitReply(hold)));
      return;
    }
    serving.permits += 1;
    socket.once("close", () => {
      serving.permits -= 1;
    });
    socket.write(replyLine(permitReply(undefined)));
  });
}

function dropped(socket: net.Socket): () => void {
  return () => {
    socket.destroy();
  };
}

function asked(
  serving: Serving,
  request: { readonly socket: net.Socket; readonly line: string },
): void {
  const { socket, line } = request;
  const parsed = parseRequest(line);
  if (parsed.kind === "error") {
    socket.end(replyLine(parsed));
    return;
  }
  const { operation, parameters } = parsed.request;
  if (operation === "permit") {
    permitted(serving, socket);
    return;
  }
  const reply =
    operation === "restart"
      ? serving.restart.requested(parameters)
      : Promise.resolve(
          invalid(
            "The workspace supervisor answers only permit and restart requests.",
          ),
        );
  reply.then((answer) => {
    if (!socket.destroyed) socket.end(replyLine(answer));
  }, dropped(socket));
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
    if (end < 0) dropped(socket)();
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
  const stopping = new AbortController();
  const serving: Serving = {
    settings,
    sockets: new Set(),
    restart: workspaceRestart({
      members: settings.members,
      permits: () => serving.permits,
      gapMilliseconds: settings.gapMilliseconds ?? 2000,
      answerMilliseconds: settings.answerMilliseconds ?? 180_000,
      signal: stopping.signal,
    }),
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
      stopping.abort();
      const closed = new Promise<void>((settle) => {
        server.close(() => {
          settle();
        });
      });
      for (const socket of serving.sockets) socket.destroy();
      await closed;
    },
  };
}
