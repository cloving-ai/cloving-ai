import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { Authority } from "../src/broker/actor/authority.ts";
import { runWaitResult } from "../src/run-wait.ts";
import {
  deliverUntil,
  executePinned,
  openedAuthority,
} from "./authority-actor-fixture.ts";
import { noon, sender } from "./effect-fixture.ts";
import { runWaitTarget } from "../src/service/run-waits.ts";
import { recorded } from "./authority-fixture.ts";
import {
  drop,
  finalAt,
  runningEffects,
  scene,
  stopped,
  stopper,
} from "./effect-stop-fixture.ts";
import {
  executeStored,
  fastTiming,
  opened,
  pin,
  storedGate,
  removeTemporaryDirectories,
  temporaryDirectory,
} from "./authority-store-fixture.ts";

after(removeTemporaryDirectories);

await test("CLV-180 cancellation waits until the child's active effect stops", async () => {
  const started = await scene(stopped);
  const { authority, send } = started;
  try {
    const [request] = await runningEffects(started, [1]);
    assert.ok(request);
    assert.equal((await send(drop)).kind, "accepted");
    assert.equal((await authority.effects.closure("run-1")).open, true);
    assert.deepEqual(await runWaitTarget(authority, "run-1"), {
      parentRunId: null,
      status: "cancelled",
      endedAt: null,
      outcome: null,
    });
    await finalAt(authority, { request, status: "stopped" });
    const target = await runWaitTarget(authority, "run-1");
    assert.deepEqual(target?.outcome, {
      kind: "cancelled",
      reason: null,
      promotionId: null,
    });
    assert.ok(target.endedAt !== null);
  } finally {
    await authority.close();
  }
  const reopened = await opened(started.directory);
  try {
    assert.deepEqual((await runWaitTarget(reopened.store, "run-1"))?.outcome, {
      kind: "cancelled",
      reason: null,
      promotionId: null,
    });
  } finally {
    await reopened.store.close();
  }
});

await test("CLV-180 wait retries read the target without loading a full authority snapshot", async () => {
  const { store } = await opened(await temporaryDirectory());
  try {
    assert.equal(
      (
        await executeStored(store, {
          kind: "admit-run",
          commandId: "admit",
          runId: "target",
          workflow: pin,
        })
      ).kind,
      "accepted",
    );
    const authority = {
      ...store,
      state: () => Promise.reject(new Error("wait loaded a full snapshot")),
    };
    for (let retry = 0; retry < 3; retry += 1) {
      assert.equal(
        (await runWaitTarget(authority, "target"))?.status,
        "queued",
      );
      assert.equal(await runWaitTarget(authority, "missing"), undefined);
    }
  } finally {
    await store.close();
  }
});

for (const [kind, fields, outcome] of [
  ["complete-run", {}, { kind: "completed", reason: null, promotionId: null }],
  [
    "complete-run",
    { outcome: "blocked", outcomeReason: "too big" },
    { kind: "blocked", reason: "too big", promotionId: null },
  ],
  ["fail-run", {}, { kind: "failed", reason: null, promotionId: null }],
  ["cancel-run", {}, { kind: "cancelled", reason: null, promotionId: null }],
] as const)
  await test(`CLV-180 stored target state ${outcome.kind} survives reopening`, async () => {
    const directory = await temporaryDirectory();
    const { store } = await opened(directory);
    try {
      assert.equal(await runWaitTarget(store, "missing"), undefined);
      for (const command of [
        {
          kind: "admit-run",
          commandId: "admit",
          runId: "target",
          workflow: pin,
        },
        {
          kind: "mark-started",
          commandId: "start",
          runId: "target",
          expectedRevision: 1,
        },
      ])
        assert.equal((await executeStored(store, command)).kind, "accepted");
      assert.deepEqual(await runWaitTarget(store, "target"), {
        parentRunId: null,
        status: "running",
        endedAt: null,
        outcome: null,
      });
      assert.equal(
        (
          await executeStored(store, {
            kind,
            ...fields,
            commandId: "end",
            runId: "target",
            expectedRevision: 2,
          })
        ).kind,
        "accepted",
      );
    } finally {
      await store.close();
    }
    const reopened = await opened(directory);
    try {
      assert.deepEqual(await runWaitTarget(reopened.store, "target"), {
        parentRunId: null,
        status: outcome.kind === "blocked" ? "completed" : outcome.kind,
        endedAt: kind === "cancel-run" ? null : Date.parse(recorded.recordedAt),
        outcome: kind === "cancel-run" ? null : outcome,
      });
    } finally {
      await reopened.store.close();
    }
  });

async function withCancelledChild(
  scenario: { readonly work: string; readonly stoppedAfter: number },
  inspect: (authority: Authority, clock: { now: string }) => Promise<void>,
): Promise<void> {
  const directory = await temporaryDirectory();
  const adapter = stopper(stopped);
  const clock = { now: noon };
  const authority = await openedAuthority(directory, {
    delivery: adapter.delivery,
    clock: () => clock.now,
    timing: fastTiming,
  });
  const send = sender(authority, clock);
  try {
    if (scenario.work === "effect")
      await runningEffects({ authority, adapter, directory, send }, [1]);
    if (scenario.work === "start") {
      await executePinned(authority, storedGate[0] ?? {});
      await deliverUntil(
        authority,
        async () => (await authority.eligibleIntents()).length === 0,
      );
    }
    assert.equal(
      (await authority.queries.run("run-1"))?.status,
      scenario.work === "start" ? "queued" : "running",
    );
    assert.equal(
      (
        await send({
          ...drop,
          expectedRevision: scenario.work === "start" ? 1 : 2,
        })
      ).kind,
      "accepted",
    );
    clock.now = new Date(
      Date.parse(noon) + scenario.stoppedAfter,
    ).toISOString();
    await deliverUntil(
      authority,
      async () =>
        (await authority.effects.closure("run-1")).closure === "cancelled",
    );
    await inspect(authority, clock);
  } finally {
    await authority.close();
  }
}

for (const work of ["start", "effect"])
  for (const stoppedAfter of [500, 2000])
    await test(`CLV-180 ${work} cancellation settles at ${String(stoppedAfter)}ms for the wait deadline`, () =>
      withCancelledChild({ work, stoppedAfter }, async (authority, clock) => {
        const target = await runWaitTarget(authority, "run-1");
        assert.ok(target);
        assert.equal(target.endedAt, Date.parse(noon) + stoppedAfter);
        const result = runWaitResult(
          { runId: "run-1", maximumWaitSeconds: 1 },
          {
            callerRunId: "parent",
            startedAt: Date.parse(noon),
            now: Date.parse(noon) + 9000,
            target: { ...target, parentRunId: "parent" },
          },
        );
        assert.deepEqual(
          result,
          stoppedAfter > 1000
            ? { kind: "refused", reason: "run-wait-timeout" }
            : { kind: "completed", outcome: target.outcome },
        );
        clock.now = new Date(Date.parse(noon) + 9000).toISOString();
        for (const condition of ["working", "stopped"])
          assert.equal(
            (
              await authority.execute(
                {
                  kind: "report-observation",
                  commandId: "late-" + condition,
                  runId: "run-1",
                  condition,
                  reason: "worker-exit",
                  operationId:
                    '["cloving-operation",0,"run-1","admission","start-run",null,null]',
                },
                { recordedAt: clock.now },
              )
            ).kind,
            "accepted",
          );
        assert.deepEqual(await runWaitTarget(authority, "run-1"), target);
      }));
