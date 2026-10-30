import assert from "node:assert/strict";
import { after, test } from "node:test";
import { commandWaitHost } from "./command-wait-host-fixture.ts";
import { eventually, withHarness } from "./service-fixture.ts";
import type { DeliveryIntent } from "../src/broker/actor/authority.ts";
import { reconciliations } from "../src/broker/actor/effect-plan.ts";
import { waitLedger, beginCheck } from "./command-wait-check-fixture.ts";
import { stopIntents } from "../src/broker/actor/stop-plan.ts";
import { context, opening, waitStore } from "./command-wait-fixture.ts";
import { checkRequest, start } from "./command-wait-check-fixture.ts";
import { stopping } from "../src/broker/actor/stop-turn.ts";
import { stored } from "./stop-opening-fixture.ts";
import { removeTemporaryDirectories } from "./authority-store-fixture.ts";

after(removeTemporaryDirectories);

for (const kind of [
  "expire-command-wait",
  "open-command-wait",
  "complete-run",
  "fail-run",
  "cancel-run",
])
  await test(`CLV-236 reopening stop state preserves the original ${kind} sequence through later joins`, async () => {
    const { store, directory } = await waitStore();
    let origin = 0;
    try {
      await store.execute(opening, context);
      await store.execute(checkRequest, context);
      const deadline = start + 2_592_000_000;
      const fields =
        kind === "expire-command-wait"
          ? { waitName: "team-review" }
          : { expectedRevision: 2 };
      const ending =
        kind === "open-command-wait"
          ? { ...opening, commandId: "end" }
          : { kind, runId: "run-1", commandId: "end", ...fields };
      const result = await store.execute(ending, {
        ...context,
        recordedAt: new Date(deadline).toISOString(),
      });
      assert.equal(result.kind, "accepted");
      origin = result.sequence;
      assert.equal(
        (
          await store.execute(
            { ...opening, commandId: "later-join" },
            { ...context, recordedAt: new Date(deadline + 1000).toISOString() },
          )
        ).kind,
        "accepted",
      );
    } finally {
      await store.close();
    }
    await stored(directory, async (connection) => {
      const state = await stopping(connection, "run-1");
      const checks = state.subjects.filter(
        (subject) => subject.kind === "protected-effect",
      );
      assert.equal(checks.length, 1);
      assert.equal(checks[0]?.stopSequence, origin);
    });
  });

await test("CLV-236 each terminal check counts stops from its original terminal sequence, even after joins", () => {
  const ledger = waitLedger();
  const operationId = beginCheck(ledger);
  ledger.at(ledger.now() + 2_592_000_000);
  ledger.accept({
    kind: "expire-command-wait",
    runId: "run-1",
    waitName: "team-review",
  });
  const stopSequence = ledger.state().sequence;
  const earlier = [1, 2, 3].map((round) => ({
    effectId: `reconcile-${String(round)}`,
    purpose: "reconcile",
    outcome: "accepted",
    stagedSequence: stopSequence - 1,
  }));
  const subject = {
    operationId,
    kind: "protected-effect",
    attempts: earlier,
    status: "running",
    receipt: "receipt",
    stopped: false,
    stopSequence,
  };
  const planning = {
    stopping: { subjects: [subject], cancelledSequence: null },
    runId: "run-1",
    closed: [],
    cancelledNow: [],
    stopLimit: 3,
    stopSupported: true,
    opening: false,
    rejected: new Set<string>(),
  };
  assert.equal(stopIntents(ledger.state(), planning).length, 1);
  const bounded = {
    ...planning,
    stopping: {
      ...planning.stopping,
      subjects: [
        {
          ...subject,
          attempts: earlier.map((attempt) => ({
            ...attempt,
            stagedSequence: stopSequence,
          })),
        },
      ],
    },
  };
  assert.deepEqual(stopIntents(ledger.state(), bounded), []);
  ledger.accept(opening);
  assert.deepEqual(stopIntents(ledger.state(), bounded), []);
});

await test("CLV-236 a recovering terminal wait check has only its stop reconciliation path", () => {
  const ledger = waitLedger();
  const operationId = beginCheck(ledger);
  ledger.at(ledger.now() + 2_592_000_000);
  ledger.accept({
    kind: "expire-command-wait",
    runId: "run-1",
    waitName: "team-review",
  });
  ledger.accept({
    kind: "expire-lease",
    runId: "run-1",
    operationId,
    leaseGeneration: 1,
  });
  assert.equal(
    ledger.state().effects.operations[operationId]?.status,
    "recovering",
  );
  assert.deepEqual(
    reconciliations(ledger.state(), {
      results: [],
      closed: [operationId],
      open: new Set(),
    }),
    [],
  );
});

await test("CLV-236 expiry tells the worker to stop an in-flight check without ending the run", () =>
  withHarness(async (harness) => {
    const stops: DeliveryIntent[] = [];
    let running = false;
    const scene = await commandWaitHost(harness, {
      delivery: {
        reconcile: () => Promise.resolve({ kind: "absent" }),
        deliver: (intent) => {
          if (intent.kind === "protected-effect") running = true;
          return Promise.resolve({
            receipt: "worker-receipt",
            worker: "command",
          });
        },
        stop: (intent) => {
          stops.push(intent);
          return Promise.resolve({
            kind: "completed",
            worker: "command",
            receipt: "worker-receipt",
            result: '{"ready":true}',
          });
        },
      },
    });
    const { ports, request, opening, clock, runId } = scene;
    assert.equal((await ports.commandWait.open(opening)).kind, "accepted");
    assert.equal(
      (await ports.commandWait.check({ ...request, commandId: "check" })).kind,
      "accepted",
    );
    await eventually(() => (running ? true : undefined));
    const wait = await ports.commandWait.read(request);
    assert.ok(wait);
    clock.now = wait.deadline;
    await eventually(() => (stops.length > 0 ? true : undefined));
    const ended = await ports.commandWait.read(request);
    assert.equal(ended?.state, "timed-out");
    assert.equal(ended.result, null);
    assert.equal(ended.reason, "command-wait-timeout");
    assert.equal((await ports.state()).runs[runId]?.status, "running");
    assert.equal(stops[0]?.operationId, wait.checkOperation);
    assert.equal(
      stops[0].commandDeadline,
      new Date(wait.deadline).toISOString(),
    );
  }));
