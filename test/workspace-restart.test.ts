import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { send } from "../src/cli/client.ts";
import { argumentRules } from "../src/cli/runtime-invocation.ts";
import { permitServer } from "../src/cli/workspace-permit-server.ts";
import { workspacePermits } from "../src/cli/workspace-permit.ts";
import type { Fields, Reply, ServiceRequest } from "../src/protocol.ts";
import { listen, type Listener } from "../src/service/transport.ts";
import { eventually } from "./service-fixture.ts";
import { testMilliseconds } from "./test-timing.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "clv-ws-restart-")));
process.on("exit", () => {
  rmSync(root, { recursive: true, force: true });
});

interface FakeMember {
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

function handled(member: FakeMember, request: ServiceRequest): Promise<Reply> {
  if (request.operation === "restart")
    return restartReply(member, request.parameters);
  if (request.parameters["after"] !== undefined) member.gapReads += 1;
  if (member.down) return refusal("authority-unavailable");
  return result({
    kind: "run-list",
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
    listener: await listen({
      path: join(runtime, "control.sock"),
      handle: (request) => handled(member, request),
    }),
  };
  return member;
}

async function withSupervisor(
  body: (scene: {
    readonly folder: string;
    readonly members: readonly FakeMember[];
    readonly close: () => Promise<void>;
  }) => Promise<void>,
): Promise<void> {
  const folder = mkdtempSync(join(root, "workspace-"));
  const members = [
    await fakeMember(folder, "alpha"),
    await fakeMember(folder, "beta"),
  ];
  const server = await permitServer({
    path: join(folder, "control.sock"),
    members: () => members,
    limits: {},
    gapMilliseconds: 20,
  });
  try {
    await body({ folder, members, close: server.close });
  } finally {
    await server.close();
    for (const member of members) await member.listener.close();
  }
}

const restarted = (folder: string, parameters: Fields) =>
  send(folder, { operation: "restart", parameters });

await test("CLV-312 the workspace restart holds the queue runs of all repositories and restarts all repositories at a common gap", () =>
  withSupervisor(async ({ folder, members }) => {
    const [alpha, beta] = members;
    assert.ok(alpha !== undefined && beta !== undefined);
    alpha.active = true;
    const reply = restarted(folder, {
      commandId: "restart-1",
      at: "gap",
      resumeQueue: true,
    });
    const permit = workspacePermits(join(folder, "control.sock"));
    await eventually(async () => {
      const held = await permit();
      return held.kind === "held" && held.hold.reason === "workspace-restart"
        ? held
        : undefined;
    });
    const reads = alpha.gapReads;
    await eventually(() => (alpha.gapReads >= reads + 2 ? true : undefined));
    assert.deepEqual(
      members.map((member) => member.restarts.length),
      [0, 0],
    );
    alpha.active = false;
    assert.deepEqual(await reply, {
      kind: "result",
      result: {
        kind: "workspace-restart",
        commandId: "restart-1",
        repositories: [
          { name: "alpha", serviceStartedAt: "alpha-start-restarted" },
          { name: "beta", serviceStartedAt: "beta-start-restarted" },
        ],
      },
    });
    assert.deepEqual(
      members.map((member) => member.restarts),
      [
        [{ commandId: "restart-1", at: "now", resumeQueue: true }],
        [{ commandId: "restart-1", at: "now", resumeQueue: true }],
      ],
    );
    assert.equal((await permit()).kind, "admitted");
  }));

await test("CLV-312 a workspace restart at now does not wait for a gap, and a second restart with another command ID is refused while one is pending", () =>
  withSupervisor(async ({ folder, members }) => {
    const [alpha] = members;
    assert.ok(alpha !== undefined);
    alpha.active = true;
    const first = restarted(folder, { commandId: "slow", at: "gap" });
    await eventually(async () => {
      const held = await workspacePermits(join(folder, "control.sock"))();
      return held.kind === "held" ? held : undefined;
    });
    const second = await restarted(folder, { commandId: "other", at: "now" });
    assert.ok(second.kind === "error");
    assert.equal(second.error.code, "workspace-restart-pending");
    alpha.active = false;
    assert.equal((await first).kind, "result");
    alpha.active = true;
    const now = await restarted(folder, {
      commandId: "fast",
      at: "now",
      settings: "files",
    });
    assert.equal(now.kind, "result");
    assert.deepEqual(alpha.restarts.at(-1), {
      commandId: "fast",
      at: "now",
      settings: "files",
    });
    const invalid = await restarted(folder, { commandId: "bad", at: "later" });
    assert.ok(invalid.kind === "error");
    assert.equal(invalid.error.code, "invalid-request");
  }));

await test("CLV-312 a repeated workspace restart with the same command ID joins the pending restart, a refusal of one repository fails the restart, and a stop of the supervisor ends a pending restart", () =>
  withSupervisor(async ({ folder, members, close }) => {
    const [alpha, beta] = members;
    assert.ok(alpha !== undefined && beta !== undefined);
    alpha.active = true;
    const first = restarted(folder, { commandId: "same" });
    const second = restarted(folder, { commandId: "same" });
    await eventually(() => (alpha.gapReads >= 2 ? true : undefined));
    alpha.active = false;
    assert.deepEqual(await second, await first);
    beta.refuses = true;
    const refused = await restarted(folder, {
      commandId: "refused",
      at: "now",
    });
    assert.ok(refused.kind === "error");
    assert.equal(refused.error.code, "workspace-restart-failed");
    assert.match(refused.error.detail, /beta \(restart-unavailable\)/);
    alpha.active = true;
    const reads = alpha.gapReads;
    const stopped = restarted(folder, { commandId: "stopped" });
    await eventually(() => (alpha.gapReads > reads ? true : undefined));
    await close();
    assert.equal((await stopped).kind, "error");
  }));

await test("CLV-312 a workspace restart keeps waiting while a repository does not answer the gap read", () =>
  withSupervisor(async ({ folder, members }) => {
    const [, beta] = members;
    assert.ok(beta !== undefined);
    const before = await restarted(folder, { commandId: "before" });
    assert.equal(before.kind, "result");
    beta.down = true;
    const reads = beta.gapReads;
    const reply = restarted(folder, { commandId: "while-down", at: "gap" });
    await eventually(() => (beta.gapReads >= reads + 2 ? true : undefined));
    beta.down = false;
    assert.equal((await reply).kind, "result");
  }));

await test("CLV-312 a workspace restart sends the command ID of the request to each repository, also an ID of 128 characters", () =>
  withSupervisor(async ({ folder, members }) => {
    const commandId = "a".repeat(128);
    assert.equal(
      (await restarted(folder, { commandId, at: "now" })).kind,
      "result",
    );
    assert.deepEqual(
      members.map((member) => member.restarts.at(-1)?.["commandId"]),
      [commandId, commandId],
    );
  }));

const stillWaiting: Reply = {
  kind: "error",
  error: { code: "still-waiting", detail: "The restart did not end." },
};

const bounded = (reply: Promise<Reply>): Promise<Reply> =>
  Promise.race([
    reply,
    delay(testMilliseconds(5000), stillWaiting, { ref: false }),
  ]);

async function failedDetail(folder: string, commandId: string) {
  const reply = await bounded(restarted(folder, { commandId, at: "now" }));
  assert.ok(reply.kind === "error");
  assert.equal(reply.error.code, "workspace-restart-failed");
  const permit = await workspacePermits(join(folder, "control.sock"))();
  assert.equal(permit.kind, "admitted");
  return reply.error.detail;
}

await test("CLV-312 a workspace restart fails and ends its queue hold when a repository fails its restart, another command cancels it, or the new service refuses a queue workflow", () =>
  withSupervisor(async ({ folder, members }) => {
    const [alpha, beta] = members;
    assert.ok(alpha !== undefined && beta !== undefined);
    beta.fails = "restart-build-failed";
    assert.match(
      await failedDetail(folder, "build"),
      /: beta \(restart-build-failed\)\.$/,
    );
    beta.fails = undefined;
    beta.cancels = true;
    alpha.bare = true;
    assert.match(
      await failedDetail(folder, "cancelled"),
      /: alpha \(restart-reply-invalid\), beta \(restart-cancelled\)\.$/,
    );
    alpha.bare = false;
    beta.cancels = false;
    beta.admits = [];
    assert.equal(
      await failedDetail(folder, "workflow"),
      [
        "The restart failed in these repositories: beta (restart-workflow-refused).",
        "beta: queue workflow develop: workflow-missing",
      ].join("\n"),
    );
  }));
