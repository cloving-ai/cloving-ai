import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { send } from "../src/cli/client.ts";
import { argumentRules } from "../src/cli/runtime-invocation.ts";
import {
  permitServer,
  type PermitSettings,
} from "../src/cli/workspace-permit-server.ts";
import { workspacePermits } from "../src/cli/workspace-permit.ts";
import type { Fields, Reply, ServiceRequest } from "../src/protocol.ts";
import { listen, type Listener } from "../src/service/transport.ts";
import { testMilliseconds } from "./test-timing.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "clv-ws-restart-")));
process.on("exit", () => {
  rmSync(root, { recursive: true, force: true });
});

export interface FakeMember {
  readonly name: string;
  readonly repository: string;
  readonly runtime: string;
  readonly restarts: Fields[];
  readonly listener: Listener;
  active: boolean;
  startedAt: string;
  gapReads: number;
  refuses: boolean;
  down: boolean;
  bare: boolean;
  fails: string | undefined;
  cancels: boolean;
  admits: readonly string[];
  workflows: readonly string[];
  pending: Fields | null;
  failure: Fields | undefined;
  queueReads: number;
  queueAnswer: Promise<void>;
  mute: string | undefined;
}

const result = (fields: Fields): Promise<Reply> =>
  Promise.resolve({ kind: "result", result: fields });

const refusal = (code: string): Promise<Reply> =>
  Promise.resolve({ kind: "error", error: { code, detail: code } });

function restartedLater(member: FakeMember, pending: Fields): void {
  member.down = true;
  setTimeout(() => {
    member.down = false;
    member.pending = null;
    if (member.fails !== undefined)
      member.failure = {
        ...pending,
        code: member.fails,
        step: "build",
        output: "build output",
      };
    if (member.fails !== undefined || member.cancels) return;
    member.startedAt = `${member.startedAt}-restarted`;
    member.workflows = member.admits;
  }, 40);
}

function restartReply(member: FakeMember, parameters: Fields): Promise<Reply> {
  const { commandId } = parameters;
  if (member.refuses) return refusal("restart-unavailable");
  if (
    typeof commandId !== "string" ||
    !argumentRules.identifier.test(commandId)
  )
    return refusal("invalid-request");
  member.restarts.push(parameters);
  const pending = { commandId, requestedAt: Date.now() };
  member.pending = pending;
  const before = member.startedAt;
  restartedLater(member, pending);
  if (member.bare) return result({ kind: "restart" });
  return result({
    kind: "restart",
    serviceStartedAt: before,
    restart: {
      state: "pending",
      ...pending,
      queueWorkflowId: "develop",
      scheduledWorkflowIds: [],
    },
  });
}

async function queueReply(member: FakeMember): Promise<Reply> {
  member.queueReads += 1;
  await member.queueAnswer;
  return {
    kind: "result",
    result: { kind: "queue", queue: { busy: member.active ? 1 : 0 } },
  };
}

async function handled(
  member: FakeMember,
  request: ServiceRequest,
): Promise<Reply> {
  if (request.operation === member.mute) return new Promise(() => undefined);
  if (request.operation === "queue") return queueReply(member);
  if (
    request.operation === "status" &&
    request.parameters["after"] === undefined
  )
    await queueReply(member);
  if (request.operation === "restart")
    return restartReply(member, request.parameters);
  if (request.parameters["after"] !== undefined) member.gapReads += 1;
  if (member.down) return refusal("authority-unavailable");
  return result({
    kind: "run-list",
    queue: { busy: Number(member.active) },
    runs: member.active ? [{ runId: "run-1", state: "running" }] : [],
    next: null,
    serviceStartedAt: member.startedAt,
    workflows: member.workflows,
    restart: member.pending,
    ...(member.failure === undefined ? {} : { restartFailure: member.failure }),
  });
}

async function fakeMember(folder: string, name: string): Promise<FakeMember> {
  const repository = join(folder, name);
  const runtime = join(repository, "run");
  await mkdir(runtime, { recursive: true });
  const member: FakeMember = {
    name,
    repository,
    runtime,
    restarts: [],
    active: false,
    startedAt: `${name}-start`,
    gapReads: 0,
    refuses: false,
    down: false,
    bare: false,
    fails: undefined,
    cancels: false,
    admits: ["develop"],
    workflows: ["develop"],
    pending: null,
    failure: undefined,
    queueReads: 0,
    queueAnswer: Promise.resolve(),
    mute: undefined,
    listener: await listen({
      path: join(runtime, "control.sock"),
      handle: (request) => handled(member, request),
    }),
  };
  return member;
}

export async function withSupervisor(
  body: (scene: {
    readonly folder: string;
    readonly members: readonly FakeMember[];
    readonly close: () => Promise<void>;
  }) => Promise<void>,
  options: Partial<Pick<PermitSettings, "limits" | "answerMilliseconds">> = {},
): Promise<void> {
  const folder = mkdtempSync(join(root, "workspace-"));
  const members = [
    await fakeMember(folder, "alpha"),
    await fakeMember(folder, "beta"),
  ];
  const server = await permitServer({
    path: join(folder, "control.sock"),
    members: () => members,
    limits: options.limits ?? {},
    gapMilliseconds: 20,
    ...(options.answerMilliseconds === undefined
      ? {}
      : { answerMilliseconds: options.answerMilliseconds }),
  });
  try {
    await body({ folder, members, close: server.close });
  } finally {
    await server.close();
    for (const member of members) await member.listener.close();
  }
}

export const restarted = (folder: string, parameters: Fields) =>
  send(folder, { operation: "restart", parameters });

const stillWaiting: Reply = {
  kind: "error",
  error: { code: "still-waiting", detail: "The restart did not end." },
};

const bounded = (reply: Promise<Reply>): Promise<Reply> =>
  Promise.race([
    reply,
    delay(testMilliseconds(5000), stillWaiting, { ref: false }),
  ]);

export async function failedDetail(folder: string, commandId: string) {
  const reply = await bounded(restarted(folder, { commandId, at: "now" }));
  assert.ok(reply.kind === "error");
  assert.equal(reply.error.code, "workspace-restart-failed");
  const permit = await workspacePermits(join(folder, "control.sock"))();
  assert.equal(permit.kind, "admitted");
  return reply.error.detail;
}
