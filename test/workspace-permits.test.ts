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
import { createConnection, createServer, type Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { eventually } from "./service-fixture.ts";
import { testMilliseconds } from "./test-timing.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "clv-permits-")));
process.on("exit", () => {
  rmSync(root, { recursive: true, force: true });
});

interface MemberState {
  busy: number | "no-queue" | "invalid";
  spentUsd: number | null | "no-spend";
  reads: number;
  answerMilliseconds?: number;
}

const missing = (code: string): Promise<Reply> =>
  Promise.resolve({ kind: "error", error: { code, detail: code } });

async function memberReply(
  state: MemberState,
  operation: string,
): Promise<Reply> {
  await delay(state.answerMilliseconds ?? 0);
  if (operation === "queue" && state.busy === "no-queue")
    return missing("queue-unavailable");
  if (operation === "queue")
    return result({
      kind: "queue",
      queue: { busy: state.busy === "invalid" ? "many" : state.busy },
    });
  if (state.spentUsd === "no-spend") return missing("unknown-operation");
  return result({ kind: "spend", spentUsd: state.spentUsd });
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
      return memberReply(state, request.operation);
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
  body: (
    permit: ReturnType<typeof workspacePermits>,
    path: string,
  ) => Promise<void>,
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
    await body(workspacePermits(server.path), server.path);
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

function rawExchange(path: string, text: string): Promise<string> {
  return new Promise((settle) => {
    const socket = createConnection({ path });
    let answer = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(text));
    socket.on("data", (chunk: string) => {
      answer += chunk;
    });
    socket.on("close", () => {
      settle(answer);
    });
  });
}

await test("CLV-312 the supervisor counts a repository with no queue as idle, and holds a permit for a queue or spend answer that it cannot use", async () => {
  await withPermits(
    { limits: { lanes: 1 }, alpha: state(0), beta: state(0) },
    async (permit) => {
      assert.equal((await permit()).kind, "admitted");
    },
  );
  const noQueue: MemberState = { busy: "no-queue", spentUsd: 0, reads: 0 };
  await withPermits(
    { limits: { lanes: 1 }, alpha: noQueue, beta: state(0) },
    async (permit) => {
      assert.equal((await permit()).kind, "admitted");
    },
  );
  const invalid: MemberState = { busy: "invalid", spentUsd: 0, reads: 0 };
  const noSpend: MemberState = { busy: 0, spentUsd: "no-spend", reads: 0 };
  for (const [alpha, detail] of [
    [invalid, "alpha: invalid-queue-status"],
    [noSpend, "alpha: unknown-operation"],
  ] as const)
    await withPermits(
      { limits: { lanes: 2, dailySpendLimitUsd: 5 }, alpha, beta: state(0) },
      async (permit) => {
        const held = await permit();
        assert.ok(held.kind === "held");
        assert.equal(
          held.hold.text,
          `Held: the workspace cannot read ${detail}`,
        );
      },
    );
});

await test("CLV-312 the supervisor answers a request that is not valid with an error, closes a frame with no end, and counts no lane for a queue that left before the answer", async () => {
  const slow: MemberState = { ...state(0), answerMilliseconds: 150 };
  await withPermits(
    { limits: { lanes: 1 }, alpha: slow, beta: state(0) },
    async (permit, path) => {
      assert.match(await rawExchange(path, "not json\n"), /"ok":false/);
      assert.match(
        await rawExchange(
          path,
          `${JSON.stringify({ protocol: 1, operation: "status", parameters: {} })}\n`,
        ),
        /invalid-request/,
      );
      assert.equal(await rawExchange(path, "x".repeat(1_048_577)), "");
      const left = createConnection({ path });
      left.on("connect", () => {
        left.write(
          `${JSON.stringify({ protocol: 1, operation: "permit", parameters: {} })}\n`,
        );
        left.destroy();
      });
      await delay(300);
      assert.equal((await permit()).kind, "admitted");
    },
  );
  await assert.rejects(
    permitServer({
      path: join(root, "long".repeat(30), "control.sock"),
      members: () => [],
      limits: {},
    }),
    /runtime-path-too-long/,
  );
});

async function answering(
  answer: string,
  body: (path: string) => Promise<void>,
) {
  const path = join(mkdtempSync(join(root, "answer-")), "control.sock");
  const server = createServer((socket) => {
    socket.once("data", () => {
      socket.write(answer.slice(0, 5));
      setTimeout(() => socket.write(answer.slice(5)), 20);
    });
  });
  await new Promise<void>((ready) => server.listen(path, ready));
  try {
    await body(path);
  } finally {
    server.close();
  }
}

await test("CLV-312 a queue holds its run for an error answer or an unknown hold of the supervisor, and reads an answer in parts", async () => {
  const unanswered = "Held: the workspace supervisor does not answer";
  for (const answer of [
    { ok: false, error: { code: "invalid-request", detail: "no" } },
    {
      ok: true,
      result: { admitted: false, hold: { reason: "lunch", text: "x" } },
    },
  ])
    await answering(`${JSON.stringify(answer)}\n`, async (path) => {
      const held = await workspacePermits(path)();
      assert.ok(held.kind === "held");
      assert.equal(held.hold.text, unanswered);
    });
  await answering(
    `${JSON.stringify({ ok: true, result: { admitted: true } })}\n`,
    async (path) => {
      const permit = await workspacePermits(path)();
      assert.ok(permit.kind === "admitted");
      permit.release();
    },
  );
});

const permitLine = `${JSON.stringify({ protocol: 1, operation: "permit", parameters: {} })}\n`;

await test("CLV-312 the supervisor closes the connection of a held permit, and a queue closes its connection after a held answer", async () => {
  await withPermits(
    { limits: { lanes: 1 }, alpha: state(1), beta: state(0) },
    async (permit, path) => {
      assert.equal((await permit()).kind, "held");
      const answer = await Promise.race([
        rawExchange(path, permitLine),
        delay(testMilliseconds(5000), "still open", { ref: false }),
      ]);
      assert.match(answer, /workspace-lanes/);
    },
  );
  const hold = { reason: "workspace-lanes", busy: 1, limit: 1, text: "x" };
  let closed = false;
  const sockets: Socket[] = [];
  const path = join(mkdtempSync(join(root, "held-")), "control.sock");
  const server = createServer((socket) => {
    sockets.push(socket);
    socket.on("close", () => {
      closed = true;
    });
    socket.once("data", () => {
      socket.write(
        `${JSON.stringify({ ok: true, result: { admitted: false, hold } })}\n`,
      );
    });
  });
  await new Promise<void>((ready) => server.listen(path, ready));
  try {
    assert.equal((await workspacePermits(path)()).kind, "held");
    assert.equal(await eventually(() => (closed ? true : undefined)), true);
  } finally {
    for (const socket of sockets) socket.destroy();
    server.close();
  }
});

await test("CLV-312 a permit that ends while another request reads the repositories still counts toward the workspace lanes", async () => {
  const alpha = state(0);
  const beta: MemberState = { ...state(0), answerMilliseconds: 300 };
  await withPermits({ limits: { lanes: 1 }, alpha, beta }, async (permit) => {
    const first = await permit();
    assert.ok(first.kind === "admitted");
    const second = permit();
    await delay(100);
    alpha.busy = 1;
    first.release();
    await delay(50);
    const answer = await second;
    assert.ok(answer.kind === "held");
    assert.equal(answer.hold.reason, "workspace-lanes");
  });
});
