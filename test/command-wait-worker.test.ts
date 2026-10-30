import assert from "node:assert/strict";
import { test } from "node:test";
import { eventually } from "./service-fixture.ts";
import { withWaitWorker } from "./command-wait-worker-fixture.ts";

const ready =
  'require("node:fs").appendFileSync("calls", "one\\n"); process.stdout.write(\'{"ready":true,"value":{"approved":true}}\');';
const running =
  'require("node:fs").appendFileSync("calls", "one\\n"); setInterval(() => {}, 1000);';

await test("CLV-236 the command worker restores a lost ready reply without spawning or charging again", () =>
  withWaitWorker(ready, async (scene) => {
    const { ports, opening, request, reporting } = scene;
    reporting.lost = true;
    assert.equal((await ports.commandWait.open(opening)).kind, "accepted");
    const check = { ...request, commandId: "check" };
    assert.equal((await ports.commandWait.check(check)).kind, "accepted");
    const operationId = (await ports.commandWait.read(request))?.checkOperation;
    assert.ok(operationId);
    await eventually(async () =>
      (await scene.result(operationId)) !== undefined ? true : undefined,
    );
    await scene.worker().close();
    assert.equal((await ports.commandWait.read(request))?.state, "waiting");
    await scene.service.close();
    reporting.lost = false;
    scene.replace('throw new Error("must-not-run")');
    await scene.reopen();
    const next = scene.currentPorts();
    const wait = await eventually(async () => {
      const wait = await next.commandWait.read(request);
      return wait?.state === "completed" ? wait : undefined;
    });
    assert.equal(wait.result, '{"approved":true}');
    assert.equal(wait.checkCount, 1);
    assert.equal((await next.commandWait.check(check)).kind, "duplicate");
    assert.equal((await scene.budget())["spent"], 0);
    assert.equal(await scene.callsText(), "one\n");
  }));

for (const ending of ["deadline", "drop"])
  await test(`CLV-236 the real command worker stops an in-flight check on ${ending}`, () =>
    withWaitWorker(running, async (scene) => {
      const { ports, request, opening } = scene;
      await ports.commandWait.open(opening);
      await ports.commandWait.check({ ...request, commandId: "check" });
      await eventually(async () =>
        (await scene.callsText().catch(() => "")) === "one\n"
          ? true
          : undefined,
      );
      const wait = await ports.commandWait.read(request);
      assert.ok(wait?.checkOperation);
      if (ending === "deadline") scene.clock.now = wait.deadline;
      else await scene.drop();
      await eventually(async () =>
        (await ports.operation(wait.checkOperation ?? ""))?.status === "stopped"
          ? true
          : undefined,
      );
      const ended = await ports.commandWait.read(request);
      assert.equal(
        ended?.state,
        ending === "deadline" ? "timed-out" : "cancelled",
      );
      assert.equal(ended.result, null);
      assert.equal(scene.stopping.calls, 1);
      assert.equal((await scene.budget())["spent"], 0);
      assert.equal(await scene.callsText(), "one\n");
    }));

for (const stop of ["unknown", "thrown"] as const)
  await test(`CLV-236 a ${stop} stop retains reconciliation and cannot report readiness`, () =>
    withWaitWorker(running, async (scene) => {
      const { ports, request, opening } = scene;
      await ports.commandWait.open(opening);
      await ports.commandWait.check({ ...request, commandId: "check" });
      await eventually(async () =>
        (await scene.callsText().catch(() => "")) === "one\n"
          ? true
          : undefined,
      );
      const wait = await ports.commandWait.read(request);
      assert.ok(wait?.checkOperation);
      scene.stopping.kind = stop;
      scene.clock.now = wait.deadline;
      await eventually(() => (scene.stopping.calls >= 2 ? true : undefined));
      const operation = await ports.operation(wait.checkOperation);
      assert.ok(operation);
      assert.equal(
        ["running", "recovering", "blocked"].includes(operation.status),
        true,
      );
      assert.equal((await ports.commandWait.read(request))?.state, "timed-out");
      assert.equal((await ports.commandWait.read(request))?.result, null);
      assert.deepEqual(
        await ports.commandWait.check({ ...request, commandId: "again" }),
        { kind: "rejected", reason: "command-wait-timeout" },
      );
      assert.equal(await scene.callsText(), "one\n");
    }));

for (const result of [
  { output: '{"ready":false}', state: "waiting", reason: null },
  {
    output: "not json",
    state: "failed",
    reason: "command-wait-invalid-output",
  },
  {
    output: '{"ready":"false"}',
    state: "failed",
    reason: "command-wait-invalid-output",
  },
  {
    output: '{"ready":true}',
    state: "failed",
    reason: "command-exit",
    exit: 1,
  },
])
  await test(`CLV-236 the command worker records ${result.output} with exit ${String(result.exit ?? 0)}`, () =>
    withWaitWorker(
      `process.stdout.write(${JSON.stringify(result.output)}); process.exitCode = ${String(result.exit ?? 0)};`,
      async (scene) => {
        const { ports, opening, request } = scene;
        await ports.commandWait.open(opening);
        await ports.commandWait.check({ ...request, commandId: "check" });
        const wait = await eventually(async () => {
          const wait = await ports.commandWait.read(request);
          return wait?.lastCheckSettledAt !== null ? wait : undefined;
        });
        assert.equal(wait.state, result.state);
        assert.equal(wait.reason, result.reason);
        assert.equal(wait.result, null);
        assert.equal(wait.checkCount, 1);
        assert.equal(
          wait.nextCheckAt,
          result.state === "waiting" ? scene.clock.now + 3_600_000 : null,
        );
        assert.equal((await scene.budget())["spent"], 0);
      },
    ));

await test("CLV-236 a restarted unfinished check records command-interrupted and never spawns", () =>
  withWaitWorker(ready, async (scene) => {
    const { ports, opening, request } = scene;
    assert.equal((await ports.commandWait.open(opening)).kind, "accepted");
    scene.mode.kind = "claimed";
    const check = { ...request, commandId: "unfinished" };
    assert.equal((await ports.commandWait.check(check)).kind, "accepted");
    const operationId = (await ports.commandWait.read(request))?.checkOperation;
    assert.ok(operationId);
    await eventually(async () =>
      (await ports.operation(operationId))?.status === "running"
        ? true
        : undefined,
    );
    await scene.service.close();
    await scene.worker().close();
    scene.replace('throw new Error("must-not-run")');
    scene.mode.kind = "worker";
    await scene.reopen();
    const next = scene.currentPorts();
    const failed = await eventually(async () => {
      const wait = await next.commandWait.read(request);
      return wait?.state === "failed" ? wait : undefined;
    });
    assert.equal(failed.reason, "command-interrupted");
    assert.equal(failed.result, null);
    assert.equal(failed.checkCount, 1);
    assert.equal((await next.commandWait.check(check)).kind, "duplicate");
    assert.equal((await scene.budget())["spent"], 0);
    await assert.rejects(scene.callsText(), { code: "ENOENT" });
  }));
