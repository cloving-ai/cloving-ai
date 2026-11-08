import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { send } from "../src/cli/client.ts";
import { permitServer } from "../src/cli/workspace-permit-server.ts";
import { workspacePermits } from "../src/cli/workspace-permit.ts";
import type { Fields, Reply, ServiceRequest } from "../src/protocol.ts";
import { listen, type Listener } from "../src/service/transport.ts";
import { eventually } from "./service-fixture.ts";

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
}

const result = (fields: Fields): Promise<Reply> =>
  Promise.resolve({ kind: "result", result: fields });

function restartedLater(member: FakeMember): void {
  setTimeout(() => {
    member.startedAt = `${member.startedAt}-restarted`;
  }, 40);
}

function handled(member: FakeMember, request: ServiceRequest): Promise<Reply> {
  if (request.operation === "restart" && member.refuses)
    return Promise.resolve({
      kind: "error",
      error: { code: "restart-unavailable", detail: "No restart." },
    });
  if (request.operation === "restart") {
    member.restarts.push(request.parameters);
    restartedLater(member);
    return result({ kind: "restart" });
  }
  if (request.parameters["after"] !== undefined) member.gapReads += 1;
  return result({
    kind: "run-list",
    runs: member.active ? [{ runId: "run-1", state: "running" }] : [],
    next: null,
    serviceStartedAt: member.startedAt,
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
        [{ commandId: "restart-1.alpha", at: "now", resumeQueue: true }],
        [{ commandId: "restart-1.beta", at: "now", resumeQueue: true }],
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
      commandId: "fast.alpha",
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
