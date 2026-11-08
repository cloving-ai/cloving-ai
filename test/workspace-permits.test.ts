import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { permitServer } from "../src/cli/workspace-permit-server.ts";
import { workspacePermits } from "../src/cli/workspace-permit.ts";
import type { Fields, Reply } from "../src/protocol.ts";
import { listen } from "../src/service/transport.ts";
import type { WorkspaceLimits } from "../src/workspace.ts";
import { eventually } from "./service-fixture.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "clv-permits-")));
process.on("exit", () => {
  rmSync(root, { recursive: true, force: true });
});

interface MemberState {
  busy: number;
  spentUsd: number | null;
  reads: number;
}

const result = (fields: Fields): Promise<Reply> =>
  Promise.resolve({ kind: "result", result: fields });

async function member(
  place: { readonly folder: string; readonly name: string },
  state: MemberState,
) {
  const { name } = place;
  const runtime = join(place.folder, name);
  await mkdir(runtime, { recursive: true });
  const listener = await listen({
    path: join(runtime, "control.sock"),
    handle: (request) => {
      state.reads += 1;
      if (request.operation === "queue")
        return result({ kind: "queue", queue: { busy: state.busy } });
      return result({ kind: "spend", spentUsd: state.spentUsd });
    },
  });
  return { name, repository: runtime, runtime, listener };
}

async function withPermits(
  input: {
    readonly limits: WorkspaceLimits;
    readonly alpha: MemberState;
    readonly beta?: MemberState;
  },
  body: (permit: ReturnType<typeof workspacePermits>) => Promise<void>,
): Promise<void> {
  const folder = mkdtempSync(join(root, "workspace-"));
  const alpha = await member({ folder, name: "alpha" }, input.alpha);
  const beta =
    input.beta === undefined
      ? {
          name: "beta",
          repository: join(folder, "b"),
          runtime: join(folder, "b"),
        }
      : await member({ folder, name: "beta" }, input.beta);
  const server = await permitServer({
    path: join(folder, "permits.sock"),
    members: () => [alpha, beta],
    limits: input.limits,
  });
  try {
    await body(workspacePermits(server.path));
  } finally {
    await server.close();
    await alpha.listener.close();
    if ("listener" in beta) await beta.listener.close();
  }
}

const state = (busy: number, spentUsd: number | null = 0): MemberState => ({
  busy,
  spentUsd,
  reads: 0,
});

await test("CLV-312 with workspace lanes 2 and two active runs in repository A, repository B gets no permit until one run ends", async () => {
  const alpha = state(2);
  await withPermits(
    { limits: { lanes: 2 }, alpha, beta: state(0) },
    async (permit) => {
      assert.deepEqual(await permit(), {
        kind: "held",
        hold: {
          reason: "workspace-lanes",
          busy: 2,
          limit: 2,
          text: "Held: 2 of 2 workspace lanes busy",
        },
      });
      alpha.busy = 1;
      const granted = await permit();
      assert.ok(granted.kind === "admitted");
      const during = await permit();
      assert.ok(during.kind === "held");
      assert.equal(during.hold.reason, "workspace-lanes");
      granted.release();
      await eventually(async () => {
        const next = await permit();
        return next.kind === "admitted" ? next : undefined;
      });
    },
  );
});

await test("CLV-312 the spend of both repositories counts toward the workspace daily spend limit", async () => {
  await withPermits(
    {
      limits: { dailySpendLimitUsd: 10 },
      alpha: state(0, 5),
      beta: state(0, 3.5),
    },
    async (permit) => {
      assert.deepEqual(await permit(), {
        kind: "held",
        hold: {
          reason: "workspace-spend",
          spentUsd: 8.5,
          limitUsd: 10,
          text: "Held: workspace spend 8.5 USD in 24 hours, 85 percent of the limit 10 USD",
        },
      });
    },
  );
  await withPermits(
    {
      limits: { dailySpendLimitUsd: 10 },
      alpha: state(0, 5),
      beta: state(0, null),
    },
    async (permit) => {
      assert.equal((await permit()).kind, "admitted");
    },
  );
});

await test("CLV-312 the supervisor holds a permit when it cannot read a repository, and gives a permit with no reads when the workspace has no limits", async () => {
  await withPermits(
    { limits: { lanes: 4 }, alpha: state(0) },
    async (permit) => {
      const held = await permit();
      assert.ok(held.kind === "held");
      assert.equal(
        held.hold.text,
        "Held: the workspace cannot read beta: service-unavailable",
      );
    },
  );
  const alpha = state(9, 900);
  await withPermits({ limits: {}, alpha }, async (permit) => {
    assert.equal((await permit()).kind, "admitted");
    assert.equal(alpha.reads, 0);
  });
});

await test("CLV-312 a queue holds its run when the workspace supervisor does not answer", async () => {
  const unanswered = {
    kind: "held",
    hold: {
      reason: "workspace-unknown",
      text: "Held: the workspace supervisor does not answer",
    },
  };
  assert.deepEqual(
    await workspacePermits(join(root, "no-supervisor.sock"))(),
    unanswered,
  );
  assert.deepEqual(
    await workspacePermits(`/${"long".repeat(40)}/permits.sock`)(),
    unanswered,
  );
});
