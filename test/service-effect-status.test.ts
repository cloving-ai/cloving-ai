import assert from "node:assert/strict";
import { test } from "node:test";
import { operationOf } from "./effect-fixture.ts";
import {
  dispatches,
  effectScene,
  requested,
  shownEffects,
  untilStates,
  type Scene,
} from "./service-effect-fixture.ts";
import { serviceLimits } from "../src/service/service.ts";
import {
  admitted,
  call,
  field,
  items,
  withHarness,
} from "./service-fixture.ts";
import { view } from "./service-views.ts";

function reasonOf(run: unknown): readonly unknown[] {
  return [
    field(run, "condition"),
    field(field(run, "reason"), "code"),
    field(run, "nextAction"),
    field(run, "humanInputCanHelp"),
  ];
}

async function shown(scene: Scene): Promise<readonly unknown[]> {
  return (await shownEffects(scene)).map((effect) => [
    field(effect, "state"),
    field(effect, "reason"),
  ]);
}

await test("CLV-049 at the service entry a protected effect with a capability that the run did not pin is not sent, and the reply and the status have the reason", () =>
  withHarness(async (harness) => {
    const scene = await effectScene(harness, { effectLimit: 5 });
    const reply = await requested(scene, {
      commandId: "c-network",
      round: 1,
      capability: "network",
    });
    assert.deepEqual(
      [
        reply.receipt.kind,
        reply.disposition?.disposition,
        reply.disposition?.reason,
        reply.operation?.status,
      ],
      ["accepted", "refused", "unadmitted-capability", "refused"],
    );
    const run = await view(harness, scene.runId);
    assert.deepEqual(await shown(scene), [
      ["refused", "unadmitted-capability"],
    ]);
    assert.deepEqual(field(run, "budget"), { limit: 5, spent: 0 });
    assert.deepEqual(field(run, "evidence"), [
      `event:${String(Reflect.get(reply.receipt, "sequence"))}`,
    ]);
    assert.equal(dispatches(scene), 0);
  }));

await test("CLV-049 at the service entry an operation above the run budget is not sent, the reply and the status have the reason, and the run sends no later protected effect", () =>
  withHarness(async (harness) => {
    const scene = await effectScene(harness, { effectLimit: 2 });
    await requested(scene, { commandId: "c-first", round: 1 });
    await untilStates(scene, ["running"]);
    const above = await requested(scene, {
      commandId: "c-above",
      round: 2,
      units: 2,
    });
    const later = await requested(scene, { commandId: "c-later", round: 3 });
    assert.deepEqual(
      [above, later].map((reply) => [
        reply.disposition?.disposition,
        reply.disposition?.reason,
      ]),
      [
        ["refused", "budget-exhausted"],
        ["refused", "budget-exhausted"],
      ],
    );
    const run = await view(harness, scene.runId);
    assert.deepEqual(await shown(scene), [
      ["running", null],
      ["refused", "budget-exhausted"],
      ["refused", "budget-exhausted"],
    ]);
    assert.deepEqual(field(run, "budget"), { limit: 2, spent: 1 });
    assert.deepEqual(
      field(run, "evidence"),
      [above, later].map(
        (reply) => `event:${String(Reflect.get(reply.receipt, "sequence"))}`,
      ),
    );
    assert.deepEqual(scene.destination.effects, [
      operationOf(scene.runId, { round: 1 }),
    ]);
    const other = await view(harness, await admitted(harness, "c-2"));
    assert.deepEqual(
      [
        field(other, "budget"),
        field(other, "effects"),
        field(other, "evidence"),
      ],
      [{ limit: 2, spent: 0 }, [], []],
    );
  }));

await test("CLV-049 after the recovery bound, status shows the blocked operation with its attempts and evidence and says that a person can help", () =>
  withHarness(async (harness) => {
    let reconciliations = 0;
    const scene = await effectScene(harness, {
      effectLimit: 5,
      lostReplies: 1,
      reconcile: () => {
        reconciliations += 1;
        return reconciliations === 1
          ? Promise.resolve({ kind: "absent" })
          : Promise.reject(new Error("the reply is lost"));
      },
    });
    await requested(scene, { commandId: "c-request", round: 1 });
    await untilStates(scene, ["blocked"]);
    const run = await view(harness, scene.runId);
    assert.deepEqual(reasonOf(run), [
      "uncertain-effect",
      "effect-blocked",
      "inspect-effect",
      true,
    ]);
    assert.deepEqual(field(run, "effects"), [
      {
        operationId: operationOf(scene.runId, { round: 1 }),
        state: "blocked",
        reason: "outcome-unknown",
        leaseGeneration: 1,
        attempts: 3,
        limit: 3,
      },
    ]);
    assert.deepEqual(field(run, "recovery"), { attempts: 3, limit: 3 });
    assert.equal(items(field(run, "evidence")).length, 3);
    assert.equal(dispatches(scene), 1);
    assert.equal(field(run, "state"), "running");
  }));

await test("CLV-049 status gives capacity and resource as the reasons of the operations that wait", () =>
  withHarness(async (harness) => {
    const scene = await effectScene(harness, {
      effectLimit: 5,
      effects: { capacity: 2 },
    });
    await requested(scene, {
      commandId: "c-owner",
      round: 1,
      resource: "repository",
    });
    await requested(scene, { commandId: "c-second", round: 2 });
    await untilStates(scene, ["running", "running"]);
    await requested(scene, {
      commandId: "c-resource",
      round: 3,
      resource: "repository",
    });
    await requested(scene, { commandId: "c-capacity", round: 4 });
    assert.deepEqual(await shown(scene), [
      ["running", null],
      ["running", null],
      ["waiting", "resource"],
      ["waiting", "capacity"],
    ]);
    assert.deepEqual(reasonOf(await view(harness, scene.runId)), [
      "working",
      "in-progress",
      null,
      false,
    ]);
    assert.equal(dispatches(scene), 2);
  }));

await test("CLV-049 a retry of a report with a known command ID returns the duplicate receipt and the stored disposition", () =>
  withHarness(async (harness) => {
    const scene = await effectScene(harness, { effectLimit: 5 });
    const reply = await requested(scene, { commandId: "c-request", round: 1 });
    await untilStates(scene, ["running"]);
    const report = {
      runId: scene.runId,
      commandId: "c-report",
      operationId: operationOf(scene.runId, { round: 1 }),
      inputDigest: String(reply.operation?.inputDigest),
      leaseGeneration: 1,
      worker: "worker-1",
      outcome: "completed",
      result: "the package is built",
    } as const;
    const first = await scene.service.worker.reportEffect(report);
    const second = await scene.service.worker.reportEffect(report);
    assert.deepEqual(
      [first.receipt.kind, second.receipt.kind],
      ["accepted", "duplicate"],
    );
    assert.equal(
      Reflect.get(second.receipt, "sequence"),
      Reflect.get(first.receipt, "sequence"),
    );
    assert.deepEqual(second.disposition, first.disposition);
    assert.deepEqual(first.disposition, {
      runId: scene.runId,
      operationId: report.operationId,
      disposition: "applied",
      reason: null,
    });
    const other = await scene.service.worker.reportEffect({
      ...report,
      commandId: "c-report-2",
    });
    assert.deepEqual(
      [other.disposition?.disposition, other.disposition?.reason],
      ["rejected", "operation-settled"],
    );
    assert.equal(second.operation?.status, "completed");
  }));

await test("CLV-049 the service applies its bound of worker commands: with the bound 1, one of 20 commands at one time is accepted, each other gets service-busy, and a repeat with the same command ID is accepted", () =>
  withHarness(async (harness) => {
    const scene = await effectScene(harness, {
      effectLimit: 5,
      limits: { ...serviceLimits, pendingWorkerCommands: 1 },
    });
    const observe = (
      index: number,
    ): ReturnType<typeof scene.service.worker.observe> =>
      scene.service.worker.observe({
        runId: scene.runId,
        commandId: `c-observe-${String(index)}`,
        condition: "working",
        reason: "progress",
      });
    const receipts = await Promise.all(
      [...Array.from({ length: 20 }).keys()].map((index) => observe(index)),
    );
    assert.deepEqual(
      receipts.map((receipt) => [receipt.kind, field(receipt, "reason")]),
      [
        ["accepted", undefined],
        ...Array.from({ length: 19 }, () => ["rejected", "service-busy"]),
      ],
    );
    assert.equal((await observe(7)).kind, "accepted");
  }));

await test("CLV-049 a dropped run whose protected operation failed has no unresolved effect: it waits only for the stop of its start, and it is cancelled after that stop report", () =>
  withHarness(async (harness) => {
    const scene = await effectScene(harness, { effectLimit: 5 });
    const reply = await requested(scene, { commandId: "c-request", round: 1 });
    await untilStates(scene, ["running"]);
    const failed = await scene.service.worker.reportEffect({
      runId: scene.runId,
      commandId: "c-report",
      operationId: operationOf(scene.runId, { round: 1 }),
      inputDigest: String(reply.operation?.inputDigest),
      leaseGeneration: 1,
      worker: "worker-1",
      outcome: "failed",
      reason: "tool-exit",
    });
    assert.equal(failed.disposition?.disposition, "applied");
    const dropped = await call(harness, {
      operation: "run-command",
      parameters: {
        command: "drop",
        runId: scene.runId,
        expectedRevision: 2,
        commandId: "c-drop",
      },
    });
    assert.deepEqual(
      field(field(dropped, "observed"), "unresolvedEffects"),
      [],
    );
    assert.deepEqual(reasonOf(await view(harness, scene.runId)), [
      "cancelling",
      "stop-not-observed",
      "observe-worker-stop",
      false,
    ]);
    await scene.service.worker.observe({
      runId: scene.runId,
      commandId: "c-stopped",
      condition: "stopped",
      reason: "worker-exit",
      operationId: JSON.stringify([
        "cloving-operation",
        0,
        scene.runId,
        "admission",
        "start-run",
        null,
        null,
      ]),
    });
    assert.deepEqual(reasonOf(await view(harness, scene.runId)), [
      "cancelled",
      "run-cancelled",
      null,
      false,
    ]);
    assert.deepEqual(await shown(scene), [["failed", "tool-exit"]]);
  }));

await test("CLV-056 the recovery value of the status names a run with a recovering operation and no blocked operation", () =>
  withHarness(async (harness) => {
    const held = Promise.withResolvers<undefined>();
    let reconciliations = 0;
    const scene = await effectScene(harness, {
      effectLimit: 5,
      lostReplies: 1,
      reconcile: () => {
        reconciliations += 1;
        return reconciliations === 1
          ? Promise.resolve({ kind: "absent" })
          : held.promise.then(() =>
              Promise.reject(new Error("the reply is lost")),
            );
      },
    });
    await requested(scene, { commandId: "c-request", round: 1 });
    await untilStates(scene, ["recovering"]);
    const run = await view(harness, scene.runId);
    assert.deepEqual(reasonOf(run), [
      "uncertain-effect",
      "effect-recovering",
      "reconcile-effect",
      false,
    ]);
    assert.deepEqual(field(run, "recovery"), { attempts: 1, limit: 3 });
    assert.equal(field(run, "state"), "running");
    held.resolve(undefined);
  }));
