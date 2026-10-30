import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { commandWaitBridge } from "../src/host/command-wait.ts";
import { commandWaitHost } from "./command-wait-host-fixture.ts";
import { call, eventually, withHarness } from "./service-fixture.ts";

await test("CLV-237 cancelling before a paused opening resumes ends retries without a wait or command", () =>
  withHarness(async (harness) => {
    const { ports, opening, calls, runId } = await commandWaitHost(harness);
    const changeRun = async (command: string) => {
      const run = (await ports.state()).runs[runId];
      assert.ok(run);
      const reply = await call(harness, {
        operation: "run-command",
        parameters: {
          command,
          runId,
          commandId: command,
          expectedRevision: run.revision,
        },
      });
      assert.equal(reply["kind"], "run-command");
    };
    await changeRun("pause");
    const entered = Promise.withResolvers<undefined>();
    let attempts = 0;
    const controller = new AbortController();
    const bridge = commandWaitBridge({
      commandWait: {
        ...ports.commandWait,
        open: async (request) => {
          attempts += 1;
          const receipt = await ports.commandWait.open(request);
          entered.resolve(undefined);
          return receipt;
        },
      },
      subject: () => Promise.resolve({ runId, commandId: "sdk:opening" }),
      runStatus: async (id) => (await ports.state()).runs[id]?.status,
      stopped: controller.signal,
      pollMilliseconds: 1,
      retryMilliseconds: 2,
    });
    try {
      const wait = { name: opening.name, input: null };
      const result = bridge.openCommandWait(wait);
      await entered.promise;
      await changeRun("drop");
      assert.equal((await ports.state()).runs[runId]?.status, "cancelled");
      assert.deepEqual(
        await Promise.race([result, delay(100).then(() => null)]),
        {
          kind: "refused",
          reason: "command-wait-run-not-running",
        },
      );
      const ended = attempts;
      await delay(10);
      assert.equal(attempts, ended);
      assert.equal(await ports.commandWait.read(opening), undefined);
      assert.equal(calls.length, 0);
    } finally {
      controller.abort();
    }
  }));

await test("CLV-236 host opens a declared wait and runs 120 checks outside the ordinary budget", () =>
  withHarness(async (harness) => {
    const scene = await commandWaitHost(harness);
    const { ports, request, opening, clock } = scene;
    const ordinary = scene.ordinary;
    assert.equal((await ordinary(1)).receipt.kind, "accepted");
    assert.equal((await ports.commandWait.open(opening)).kind, "accepted");
    for (let round = 1; round <= 121; round += 1) {
      clock.output =
        round === 121
          ? '{"ready":true,"value":{"approved":true}}'
          : '{"ready":false}';
      assert.equal(
        (
          await ports.commandWait.check({
            ...request,
            commandId: `check-${String(round)}`,
          })
        ).kind,
        "accepted",
      );
      await eventually(async () => {
        const wait = await ports.commandWait.read(request);
        return wait?.lastCheckSettledAt === clock.now ? wait : undefined;
      });
      assert.equal((await scene.budget())["spent"], 1);
      clock.now += 3_600_000;
    }
    const wait = await ports.commandWait.read(request);
    assert.equal(wait?.checkCount, 121);
    assert.equal(wait.state, "completed");
    assert.equal(wait.result, '{"approved":true}');
    await ordinary(2);
    assert.equal((await scene.budget())["spent"], 2);
    assert.equal((await ordinary(3)).disposition?.disposition, "refused");
    assert.equal(scene.calls.length, 123);
  }));

await test("CLV-236 the service automatically expires a paused wait after downtime", () =>
  withHarness(async (harness) => {
    const scene = await commandWaitHost(harness);
    const { ports, opening, request, clock, runId } = scene;
    assert.equal((await ports.commandWait.open(opening)).kind, "accepted");
    const before = await ports.commandWait.read(request);
    assert.ok(before);
    assert.equal(
      (
        await call(harness, {
          operation: "run-command",
          parameters: {
            command: "pause",
            runId,
            commandId: "pause",
            expectedRevision: 2,
          },
        })
      )["kind"],
      "run-command",
    );
    assert.equal((await ports.state()).runs[runId]?.status, "paused");
    await scene.service.close();
    clock.now = before.deadline;
    await harness.start(scene.settings);
    const next = scene.currentPorts();
    const expired = await eventually(async () => {
      const wait = await next.commandWait.read(request);
      return wait?.state === "timed-out" ? wait : undefined;
    });
    assert.equal(expired.deadline, before.deadline);
    assert.equal(expired.settledAt, before.deadline);
    assert.equal(expired.reason, "command-wait-timeout");
    assert.equal(expired.checkCount, 0);
    assert.equal(scene.calls.length, 0);
  }));

await test("CLV-236 host joins one wait and checks it with an exhausted ordinary budget", () =>
  withHarness(async (harness) => {
    const scene = await commandWaitHost(harness);
    const { commandWait } = scene.ports;
    const { opening, request, clock } = scene;
    await scene.ordinary(1);
    await scene.ordinary(2);
    await eventually(() => (scene.calls.length === 2 ? true : undefined));
    assert.equal(
      (await scene.ordinary(3)).disposition?.reason,
      "budget-exhausted",
    );
    assert.equal((await commandWait.open(opening)).kind, "accepted");
    const before = await commandWait.read(request);
    clock.now += 60_000;
    assert.equal(
      (await commandWait.open({ ...opening, commandId: "join" })).kind,
      "accepted",
    );
    assert.deepEqual(await commandWait.read(request), before);
    assert.deepEqual(
      await commandWait.open({ ...opening, commandId: "changed", input: "{}" }),
      {
        kind: "rejected",
        reason: "command-wait-input-mismatch",
      },
    );
    clock.output = '{"ready":true}';
    assert.equal(
      (await commandWait.check({ ...request, commandId: "check" })).kind,
      "accepted",
    );
    await eventually(async () =>
      (await commandWait.read(request))?.state === "completed"
        ? true
        : undefined,
    );
    assert.equal(
      (await commandWait.open({ ...opening, commandId: "terminal" })).kind,
      "accepted",
    );
    assert.equal((await commandWait.read(request))?.result, "null");
    assert.equal(scene.calls.length, 3);
    assert.equal((await scene.budget())["spent"], 2);
  }));

await test("CLV-236 host refuses unknown waits and does not admit an early or overlapping check", () =>
  withHarness(async (harness) => {
    const scene = await commandWaitHost(harness);
    const { commandWait } = scene.ports;
    const unknown = { ...scene.opening, name: "missing" };
    assert.equal(await commandWait.read(unknown), undefined);
    assert.deepEqual(await commandWait.open(unknown), {
      kind: "rejected",
      reason: "command-wait-not-declared",
    });
    assert.deepEqual(await commandWait.open({ ...unknown, name: "toString" }), {
      kind: "rejected",
      reason: "command-wait-not-declared",
    });
    assert.deepEqual(await commandWait.check(unknown), {
      kind: "rejected",
      reason: "unknown-command-wait",
    });
    assert.equal((await commandWait.open(scene.opening)).kind, "accepted");
    const check = { ...scene.request, commandId: "check" };
    assert.equal((await commandWait.check(check)).kind, "accepted");
    assert.equal((await commandWait.check(check)).kind, "duplicate");
    await eventually(async () =>
      (await commandWait.read(scene.request))?.lastCheckSettledAt !== null
        ? true
        : undefined,
    );
    assert.deepEqual(
      await commandWait.check({ ...check, commandId: "early" }),
      { kind: "rejected", reason: "command-wait-check-not-due" },
    );
    assert.equal(scene.calls.length, 1);
  }));

await test("CLV-236 host restart retains the budget and schedule and runs one overdue check", () =>
  withHarness(async (harness) => {
    const scene = await commandWaitHost(harness);
    const { request, opening, clock } = scene;
    await scene.ordinary(1);
    await scene.ports.commandWait.open(opening);
    await scene.ports.commandWait.check({ ...request, commandId: "first" });
    const pending = await eventually(async () => {
      const wait = await scene.ports.commandWait.read(request);
      return wait?.lastCheckSettledAt === clock.now ? wait : undefined;
    });
    await scene.service.close();
    clock.now += 3 * 86_400_000;
    const restarted = await harness.start(scene.settings);
    const { commandWait } = scene.currentPorts();
    assert.deepEqual(await commandWait.read(request), pending);
    assert.equal((await scene.budget())["spent"], 1);
    assert.equal(
      (await commandWait.check({ ...request, commandId: "overdue" })).kind,
      "accepted",
    );
    const next = await eventually(async () => {
      const wait = await commandWait.read(request);
      return wait?.lastCheckSettledAt === clock.now ? wait : undefined;
    });
    assert.equal(next.checkCount, 2);
    assert.equal(next.nextCheckAt, clock.now + 3_600_000);
    assert.equal(next.deadline, pending.deadline);
    clock.now += 3_600_000;
    clock.output = '{"ready":true,"value":42}';
    await commandWait.check({ ...request, commandId: "ready" });
    await eventually(async () =>
      (await commandWait.read(request))?.state === "completed"
        ? true
        : undefined,
    );
    await restarted.close();
    await harness.start(scene.settings);
    const terminal = scene.currentPorts().commandWait;
    assert.equal(
      (await terminal.open({ ...opening, commandId: "terminal" })).kind,
      "accepted",
    );
    assert.equal((await terminal.read(request))?.result, "42");
    assert.equal((await scene.budget())["spent"], 1);
    assert.equal(scene.calls.length, 4);
  }));
