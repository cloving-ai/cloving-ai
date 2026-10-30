import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { commandWaitBridge } from "../src/host/command-wait.ts";
import type { CommandWaitState } from "../src/authority/command-waits.ts";

const pending: CommandWaitState = {
  runId: "run-1",
  name: "team-review",
  command: "review-state",
  inputDigest: "sha256:input",
  maximumWaitSeconds: 60,
  pollEverySeconds: 10,
  startedAt: 0,
  deadline: 60000,
  nextCheckAt: 0,
  state: "waiting",
  checkCount: 0,
  checkOperation: null,
  lastCheckSettledAt: null,
  result: null,
  settledAt: null,
  reason: null,
};

function scene(states: readonly (CommandWaitState | undefined)[]) {
  const reads = [...states];
  const requests: unknown[] = [];
  const port = {
    open: (request: unknown) => {
      requests.push(["open", request]);
      return Promise.resolve<{ kind: string; reason?: string }>({
        kind: "accepted",
      });
    },
    check: (request: unknown) => {
      requests.push(["check", request]);
      return Promise.resolve<{ kind: string; reason?: string }>({
        kind: "accepted",
      });
    },
    read: () => Promise.resolve(reads.length > 1 ? reads.shift() : reads[0]),
  };
  const controller = new AbortController();
  const host = {
    commandWait: port,
    runStatus: () => Promise.resolve<string | undefined>("running"),
    subject: () =>
      Promise.resolve<
        { readonly runId: string; readonly commandId: string } | undefined
      >({ runId: "run-1", commandId: "sdk:step-1" }),
    stopped: controller.signal,
    pollMilliseconds: 1,
    retryMilliseconds: 2,
  };
  return { requests, port, host, controller, bridge: commandWaitBridge(host) };
}

await test("CLV-237 host command waits use stable SDK identity and the host's pinned state", async () => {
  const future = {
    ...pending,
    nextCheckAt: Date.now() + 10000,
    deadline: Date.now() + 60000,
  };
  const ready = {
    ...future,
    state: "completed" as const,
    result: '{"approved":true}',
    checkOperation: null,
  };
  const { requests, bridge } = scene([
    pending,
    { ...pending, checkOperation: "check-1" },
    future,
    ready,
  ]);
  assert.deepEqual(
    await bridge.openCommandWait({
      name: "team-review",
      input: { change: 42 },
    }),
    { kind: "pending", deadline: 60000, nextCheckAt: 0 },
  );
  assert.deepEqual(await bridge.checkCommandWait({ name: "team-review" }), {
    kind: "pending",
    deadline: future.deadline,
    nextCheckAt: future.nextCheckAt,
  });
  assert.deepEqual(await bridge.checkCommandWait({ name: "team-review" }), {
    kind: "ready",
    value: { approved: true },
  });
  assert.deepEqual(requests, [
    [
      "open",
      {
        runId: "run-1",
        commandId: "sdk:step-1",
        name: "team-review",
        input: '{"change":42}',
      },
    ],
  ]);
});

await test("CLV-237 host command wait checks settle without exposing in-flight state", async () => {
  const next = {
    ...pending,
    nextCheckAt: Date.now() + 10000,
    deadline: Date.now() + 60000,
  };
  const { requests, bridge } = scene([
    pending,
    { ...pending, checkOperation: "check-1" },
    next,
  ]);
  assert.deepEqual(await bridge.checkCommandWait({ name: "team-review" }), {
    kind: "pending",
    deadline: next.deadline,
    nextCheckAt: next.nextCheckAt,
  });
  assert.deepEqual(requests, [
    ["check", { runId: "run-1", commandId: "sdk:step-1", name: "team-review" }],
  ]);
});

for (const [state, expected] of [
  [undefined, { kind: "refused", reason: "unknown-command-wait" }],
  [
    { ...pending, state: "timed-out", reason: "command-wait-timeout" },
    { kind: "timed-out", reason: "command-wait-timeout" },
  ],
  [
    { ...pending, state: "failed", reason: "command-interrupted" },
    { kind: "failed", reason: "command-interrupted" },
  ],
  [
    { ...pending, state: "cancelled", reason: "command-wait-run-ended" },
    { kind: "failed", reason: "command-wait-run-ended" },
  ],
] as const)
  await test(`CLV-237 host wait reports ${expected.reason}`, async () => {
    const { bridge, requests } = scene([state]);
    assert.deepEqual(
      await bridge.checkCommandWait({ name: "team-review" }),
      expected,
    );
    assert.deepEqual(requests, []);
  });

for (const reason of [
  "command-wait-check-in-flight",
  "command-wait-check-not-due",
  "command-wait-ended",
])
  await test(`CLV-237 a concurrent ${reason} check joins the recorded wait`, async () => {
    const next = { ...pending, nextCheckAt: Date.now() + 10000 };
    const { port, bridge } = scene([pending, next]);
    port.check = () => Promise.resolve({ kind: "rejected", reason });
    assert.deepEqual(await bridge.checkCommandWait({ name: "team-review" }), {
      kind: "pending",
      deadline: next.deadline,
      nextCheckAt: next.nextCheckAt,
    });
  });

await test("CLV-237 host waits refuse missing ports, missing world runs and invalid openings", async () => {
  const { host, port } = scene([pending]);
  const missingPort = commandWaitBridge({
    subject: host.subject,
    runStatus: host.runStatus,
    stopped: host.stopped,
    pollMilliseconds: 1,
    retryMilliseconds: 2,
  });
  const missingRun = commandWaitBridge({
    ...host,
    subject: () => Promise.resolve(undefined),
  });
  for (const bridge of [missingPort, missingRun]) {
    assert.deepEqual(
      await bridge.openCommandWait({ name: "team-review", input: null }),
      { kind: "unavailable", reason: "cloving-host-unavailable" },
    );
    assert.deepEqual(await bridge.checkCommandWait({ name: "team-review" }), {
      kind: "unavailable",
      reason: "cloving-host-unavailable",
    });
  }
  const bridge = commandWaitBridge(host);
  assert.deepEqual(
    await Reflect.apply(bridge.openCommandWait, undefined, [{}]),
    { kind: "refused", reason: "invalid-command-wait-request" },
  );
  port.open = () =>
    Promise.resolve({ kind: "rejected", reason: "command-wait-not-declared" });
  assert.deepEqual(
    await bridge.openCommandWait({ name: "unknown", input: null }),
    { kind: "refused", reason: "command-wait-not-declared" },
  );
});

for (const [receipt, expected] of [
  [
    { kind: "failed", reason: "storage-failure" },
    { kind: "failed", reason: "storage-failure" },
  ],
  [{ kind: "rejected" }, { kind: "refused", reason: "rejected" }],
  [
    { kind: "rejected", reason: "command-wait-timeout" },
    { kind: "timed-out", reason: "command-wait-timeout" },
  ],
])
  await test(`CLV-237 host waits preserve ${String(receipt?.reason ?? receipt?.kind)} receipts`, async () => {
    assert.ok(receipt && expected);
    const { port, bridge } = scene([pending]);
    port.check = () => Promise.resolve(receipt);
    assert.deepEqual(
      await bridge.checkCommandWait({ name: "team-review" }),
      expected,
    );
  });

await test("CLV-237 paused command waits suspend before consulting authority again", async () => {
  const { port, bridge } = scene([pending]);
  port.check = () =>
    Promise.resolve({
      kind: "rejected",
      reason: "command-wait-run-not-running",
    });
  const before = Date.now();
  const result = await bridge.checkCommandWait({ name: "team-review" });
  assert.equal(result.kind, "pending");
  assert.ok("nextCheckAt" in result);
  assert.ok(result.nextCheckAt >= before + 1000);
});

await test("CLV-237 host waits expose the schedule and the null default result", async () => {
  const next = {
    ...pending,
    deadline: Date.now() + 60000,
    nextCheckAt: Date.now() + 30000,
  };
  const { bridge, requests } = scene([
    next,
    { ...pending, nextCheckAt: null },
    { ...pending, state: "completed", result: null },
  ]);
  assert.deepEqual(await bridge.checkCommandWait({ name: "team-review" }), {
    kind: "pending",
    deadline: next.deadline,
    nextCheckAt: next.nextCheckAt,
  });
  assert.deepEqual(
    await bridge.openCommandWait({ name: "team-review", input: null }),
    {
      kind: "pending",
      deadline: pending.deadline,
      nextCheckAt: pending.deadline,
    },
  );
  assert.deepEqual(await bridge.checkCommandWait({ name: "team-review" }), {
    kind: "ready",
    value: null,
  });
  assert.equal(requests.length, 1);
});

await test("CLV-237 stopping the host during a command check leaves its SDK step unfinished", async () => {
  const { port, bridge, controller } = scene([
    pending,
    { ...pending, checkOperation: "check-1" },
  ]);
  const read = port.read;
  let reads = 0;
  port.read = async () => {
    const wait = await read();
    reads += 1;
    if (reads > 1) controller.abort();
    return wait;
  };
  const completion = { settled: false };
  const checking = bridge.checkCommandWait({ name: "team-review" }).then(() => {
    completion.settled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completion.settled, false);
  assert.equal(reads, 2);
  assert.ok(checking instanceof Promise);
});

await test("CLV-237 deadline checks reach authority even when the next check is later", async () => {
  const { bridge, port, requests } = scene([
    { ...pending, deadline: 0, nextCheckAt: Date.now() + 10000 },
  ]);
  port.check = (request) => {
    requests.push(["check", request]);
    return Promise.resolve({
      kind: "rejected",
      reason: "command-wait-timeout",
    });
  };
  assert.deepEqual(await bridge.checkCommandWait({ name: "team-review" }), {
    kind: "timed-out",
    reason: "command-wait-timeout",
  });
  assert.equal(requests.length, 1);
});

for (const method of ["open", "check"] as const)
  await test(`CLV-237 ${method} retries busy replies with the same command after a bounded delay`, async () => {
    const { bridge, port, host } = scene([pending]);
    const requests: unknown[] = [];
    const times: number[] = [];
    host.retryMilliseconds = 20;
    port[method] = (request) => {
      requests.push(request);
      times.push(performance.now());
      return Promise.resolve(
        requests.length < 3
          ? { kind: "rejected", reason: "service-busy" }
          : { kind: "accepted" },
      );
    };
    const result = await (method === "open"
      ? bridge.openCommandWait({ name: "team-review", input: { change: 42 } })
      : bridge.checkCommandWait({ name: "team-review" }));
    assert.deepEqual(result, {
      kind: "pending",
      deadline: pending.deadline,
      nextCheckAt: pending.nextCheckAt,
    });
    assert.deepEqual(
      requests,
      Array.from({ length: 3 }, () => requests[0]),
    );
    assert.equal(times.length, 3);
    assert.ok(
      Number(times[1]) - Number(times[0]) >= host.retryMilliseconds - 1,
    );
    assert.ok(
      Number(times[2]) - Number(times[1]) >= host.retryMilliseconds - 1,
    );
  });

for (const method of ["open", "check"] as const)
  await test(`CLV-237 ${method} keeps failed command receipts terminal`, async () => {
    const { bridge, port } = scene([pending]);
    let calls = 0;
    port[method] = () => {
      calls += 1;
      return Promise.resolve({ kind: "failed", reason: "command-failed" });
    };
    const result =
      method === "open"
        ? await bridge.openCommandWait({ name: "team-review", input: null })
        : await bridge.checkCommandWait({ name: "team-review" });
    assert.deepEqual(result, { kind: "failed", reason: "command-failed" });
    assert.equal(calls, 1);
  });

for (const method of ["open", "check"] as const)
  await test(`CLV-237 stopping during a busy ${method} keeps its step unfinished without another dispatch`, async () => {
    const { bridge, port, controller, host } = scene([pending]);
    const entered = Promise.withResolvers<undefined>();
    let calls = 0;
    let settled = false;
    port[method] = () => {
      calls += 1;
      entered.resolve(undefined);
      return Promise.resolve({ kind: "rejected", reason: "service-busy" });
    };
    const result = (
      method === "open"
        ? bridge.openCommandWait({ name: "team-review", input: null })
        : bridge.checkCommandWait({ name: "team-review" })
    ).then(() => {
      settled = true;
    });
    await entered.promise;
    controller.abort();
    await delay(host.retryMilliseconds * 2);
    assert.equal(settled, false);
    assert.equal(calls, 1);
    assert.ok(result instanceof Promise);
  });
