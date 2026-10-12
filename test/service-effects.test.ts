import assert from "node:assert/strict";
import { test } from "node:test";
import { operationOf, inputDigest } from "./effect-fixture.ts";
import { digestOf } from "./digest-fixture.ts";
import {
  afterLease,
  dispatches,
  effectScene,
  requested,
  shownEffects,
  untilStates,
} from "./service-effect-fixture.ts";
import { alterDatabase } from "./authority-store-fixture.ts";
import { call, field, items, withHarness } from "./service-fixture.ts";
import { view } from "./service-views.ts";

function reasonOf(run: unknown): readonly unknown[] {
  return [
    field(run, "condition"),
    field(field(run, "reason"), "code"),
    field(run, "nextAction"),
    field(run, "humanInputCanHelp"),
  ];
}

await test("CLV-049 a protected request at the worker port gets the operation ID of its scope, the digests of its input, the recovery limit of the settings and the session epoch", () =>
  withHarness(async (harness) => {
    const scene = await effectScene(harness, { effectLimit: 5 });
    const reply = await requested(scene, { commandId: "c-request", round: 1 });
    const operationId = operationOf(scene.runId, { round: 1 });
    assert.equal(reply.receipt.kind, "accepted", JSON.stringify(reply));
    assert.deepEqual(reply.disposition, {
      runId: scene.runId,
      operationId,
      disposition: "admitted",
      reason: null,
    });
    assert.deepEqual(
      [
        reply.operation?.operationId,
        reply.operation?.payload,
        reply.operation?.inputDigest,
        reply.operation?.recoveryLimit,
      ],
      [
        operationId,
        digestOf("build the package"),
        inputDigest({
          capability: "fake-harness",
          method: "run-turn",
          target: "workspace/main",
          payload: digestOf("build the package"),
        }),
        3,
      ],
    );
    await untilStates(scene, ["running"]);
    assert.deepEqual(scene.destination.effects, [operationId]);
    const page = await call(harness, {
      operation: "events",
      parameters: { after: 0, limit: 100, runId: scene.runId },
    });
    assert.deepEqual(
      items(field(page, "events"))
        .map((event) => field(event, "type"))
        .slice(-3),
      ["effect.requested", "lease.granted", "operation.reconciled"],
    );
  }));

await test("CLV-049 a given epoch replaces the session epoch at the worker port, and a request or a report with an earlier epoch commits nothing", () =>
  withHarness(async (harness) => {
    const scene = await effectScene(harness, { effectLimit: 5 });
    const stale = await requested(scene, {
      commandId: "c-stale",
      round: 1,
      epoch: scene.service.epoch - 1,
    });
    assert.deepEqual(stale, {
      receipt: { kind: "rejected", reason: "stale-epoch" },
      disposition: null,
      operation: null,
    });
    const present = await requested(scene, {
      commandId: "c-present",
      round: 1,
      epoch: scene.service.epoch,
    });
    assert.equal(present.disposition?.disposition, "admitted");
    await untilStates(scene, ["running"]);
    const report = {
      runId: scene.runId,
      operationId: operationOf(scene.runId, { round: 1 }),
      inputDigest: String(present.operation?.inputDigest),
      leaseGeneration: 1,
      worker: "worker-1",
      outcome: "completed",
      result: "the package is built",
    } as const;
    const late = await scene.service.worker.reportEffect({
      ...report,
      commandId: "c-report-stale",
      epoch: scene.service.epoch - 1,
    });
    assert.deepEqual(
      [late.receipt, late.disposition, late.operation?.status],
      [{ kind: "rejected", reason: "stale-epoch" }, null, "running"],
    );
    const applied = await scene.service.worker.reportEffect({
      ...report,
      commandId: "c-report",
    });
    assert.deepEqual(
      [
        applied.disposition?.disposition,
        applied.operation?.status,
        applied.operation?.result,
      ],
      ["applied", "completed", digestOf("the package is built")],
    );
  }));

await test("CLV-049 a request with a scope that is not valid, or with a payload above the text limit of a worker, is rejected at the worker port and commits nothing", () =>
  withHarness(async (harness) => {
    const scene = await effectScene(harness, { effectLimit: 5 });
    const invalid = await scene.service.worker.requestEffect({
      runId: scene.runId,
      commandId: "c-invalid",
      scope: { phase: "work", operation: "an effect", round: 1 },
      capability: "fake-harness",
      method: "run-turn",
      target: "workspace/main",
      payload: "build the package",
      units: 1,
    });
    assert.deepEqual(invalid, {
      receipt: { kind: "rejected", reason: "invalid-operation-scope" },
      disposition: null,
      operation: null,
    });
    const long = await requested(scene, {
      commandId: "c-long",
      round: 1,
      payload: "x".repeat(65_537),
    });
    assert.deepEqual(
      [Reflect.get(long.receipt, "reason"), long.disposition, long.operation],
      ["input-too-large", null, null],
    );
    assert.deepEqual(await shownEffects(scene), []);
    assert.equal(dispatches(scene), 0);
  }));

await test("CLV-049 EV-09 passes at the service with one dispatch at the fake destination: after a lost reply the service reconciles the same operation, and a retry of the request adds no dispatch", () =>
  withHarness(async (harness) => {
    const scene = await effectScene(harness, {
      effectLimit: 5,
      lostReplies: 1,
    });
    const reply = await requested(scene, { commandId: "c-request", round: 1 });
    const operationId = operationOf(scene.runId, { round: 1 });
    await untilStates(scene, ["running"]);
    const retry = await requested(scene, {
      commandId: "c-request-again",
      round: 1,
      transport: "retry 2 of call-7",
    });
    assert.deepEqual(
      [reply.disposition?.disposition, retry.disposition?.disposition],
      ["admitted", "existing"],
    );
    assert.deepEqual(
      [retry.operation?.receipt, retry.operation?.attempts],
      ["receipt-1", 1],
    );
    assert.deepEqual(scene.destination.effects, [operationId]);
    assert.deepEqual(scene.destination.calls, [
      `reconcile ${operationId}`,
      `deliver ${operationId}`,
      `reconcile ${operationId}`,
    ]);
    const run = await view(harness, scene.runId);
    assert.deepEqual(reasonOf(run), ["working", "in-progress", null, false]);
    assert.deepEqual(field(run, "effects"), [
      {
        operationId,
        state: "running",
        reason: null,
        leaseGeneration: 1,
        attempts: 1,
        limit: 3,
      },
    ]);
    assert.deepEqual(field(run, "budget"), { limit: 5, spent: 1 });
    assert.equal(items(field(run, "evidence")).length, 1);
  }));

await test("CLV-049 EV-10 passes at the service with one dispatch at the fake destination: after the lease expiry the service rejects the late result and denies a new protected request of that generation", () =>
  withHarness(async (harness) => {
    const scene = await effectScene(harness, { effectLimit: 5 });
    const reply = await requested(scene, {
      commandId: "c-request",
      round: 1,
      resource: "repository",
    });
    const operationId = operationOf(scene.runId, { round: 1 });
    await untilStates(scene, ["running"]);
    scene.clock.now = afterLease;
    await untilStates(scene, ["recovering"]);
    const late = await scene.service.worker.reportEffect({
      runId: scene.runId,
      commandId: "c-late",
      operationId,
      inputDigest: String(reply.operation?.inputDigest),
      leaseGeneration: 1,
      worker: "worker-1",
      outcome: "completed",
      result: "the late result",
    });
    const child = await requested(scene, {
      commandId: "c-child",
      round: 2,
      source: operationId,
      sourceGeneration: 1,
    });
    assert.deepEqual(
      [late, child].map((answer) => [
        answer.receipt.kind,
        answer.disposition?.disposition,
        answer.disposition?.reason,
        answer.operation?.status ?? null,
      ]),
      [
        ["accepted", "rejected", "lease-expired", "recovering"],
        ["accepted", "denied", "lease-expired", null],
      ],
    );
    assert.deepEqual(scene.destination.effects, [operationId]);
    assert.equal(dispatches(scene), 1);
    const run = await view(harness, scene.runId);
    assert.deepEqual(reasonOf(run), [
      "uncertain-effect",
      "effect-recovering",
      "reconcile-effect",
      false,
    ]);
    assert.equal(items(field(run, "evidence")).length, 2);
    assert.equal(field(run, "state"), "running");
  }));

await test("CLV-049 the recovery limit of the settings is the limit of each requested operation, and a limit outside 1 to 10 refuses the start of the service", () =>
  withHarness(async (harness) => {
    const refusals = [];
    for (const recoveryLimit of [0, 11])
      refusals.push(await harness.attempt({ effects: { recoveryLimit } }));
    assert.deepEqual(
      refusals.map((refused) => [refused.kind, field(refused, "reason")]),
      [
        ["refused", "invalid-configuration"],
        ["refused", "invalid-configuration"],
      ],
    );
    const scene = await effectScene(harness, {
      effectLimit: 5,
      effects: { recoveryLimit: 2 },
    });
    const reply = await requested(scene, { commandId: "c-request", round: 1 });
    assert.equal(reply.operation?.recoveryLimit, 2);
    assert.deepEqual(
      (await shownEffects(scene)).map((effect) => field(effect, "limit")),
      [2],
    );
  }));

await test("CLV-049 a request whose commit fails gets the failed receipt at the worker port, with no disposition and no operation, and the retry after a new start admits one operation", () =>
  withHarness(async (harness) => {
    const first = await effectScene(harness, { effectLimit: 5 });
    await first.service.close();
    alterDatabase(
      harness.stateDirectory,
      "CREATE TRIGGER fail_lease BEFORE INSERT ON leases BEGIN SELECT RAISE(ABORT, 'injected-lease-failure'); END;",
    );
    const failing = { ...first, service: await harness.start(first.options) };
    const failed = await requested(failing, {
      commandId: "c-request",
      round: 1,
    });
    assert.deepEqual(failed, {
      receipt: {
        kind: "failed",
        reason: "storage-failure",
        detail: "injected-lease-failure",
      },
      disposition: null,
      operation: null,
    });
    await failing.service.close();
    alterDatabase(harness.stateDirectory, "DROP TRIGGER fail_lease");
    const repaired = { ...first, service: await harness.start(first.options) };
    const retried = await requested(repaired, {
      commandId: "c-request",
      round: 1,
    });
    assert.deepEqual(
      [retried.receipt.kind, retried.disposition?.disposition],
      ["accepted", "admitted"],
    );
    await untilStates(repaired, ["running"]);
    assert.equal(dispatches(repaired), 1);
  }));
