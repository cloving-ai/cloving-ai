import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { Delivery } from "../src/broker/actor/authority.ts";
import {
  deliverUntil,
  executePinned,
  fastTiming,
  openedAuthority,
} from "./authority-actor-fixture.ts";
import {
  removeTemporaryDirectories,
  storedGate,
  temporaryDirectory,
} from "./authority-store-fixture.ts";
import { noon } from "./effect-fixture.ts";
import {
  drop,
  quiet,
  scene,
  stopped,
  stopper,
  stops,
  type Reply,
  type Stopper,
} from "./effect-stop-fixture.ts";

after(removeTemporaryDirectories);

const start = storedGate[0] ?? {};

interface Unreachable {
  readonly delivery: Delivery;
  readonly calls: string[];
  readonly reached: () => boolean;
}

function unreachableAtFirst(failures: number): Unreachable {
  const adapter = stopper(stopped);
  let remaining = failures;
  return {
    calls: adapter.calls,
    reached: () => remaining === 0,
    delivery: {
      ...adapter.delivery,
      reconcile: (intent, signal) => {
        if (remaining === 0) return adapter.delivery.reconcile(intent, signal);
        remaining -= 1;
        return Promise.reject(new Error("destination unreachable"));
      },
    },
  };
}

await test("CLV-049 a dropped run with a failed start reconciles the released intent and becomes cancelled", async () => {
  const directory = await temporaryDirectory();
  const adapter = unreachableAtFirst(2);
  const authority = await openedAuthority(directory, {
    delivery: adapter.delivery,
    clock: () => noon,
    timing: fastTiming,
  });
  assert.equal((await executePinned(authority, start)).kind, "accepted");
  await deliverUntil(authority, () => Promise.resolve(adapter.reached()));
  await quiet(authority);
  assert.equal(
    (
      await authority.execute(
        { ...drop, expectedRevision: 1 },
        {
          recordedAt: noon,
        },
      )
    ).kind,
    "accepted",
  );
  await deliverUntil(
    authority,
    async () =>
      (await authority.effects.closure("run-1")).closure === "cancelled",
  );
  const records = await authority.operations();
  assert.deepEqual(
    records.map((record) =>
      record.deliveries.map((item) => [item.purpose, item.outcome]),
    ),
    [
      [
        ["dispatch", "failed"],
        ["dispatch", "failed"],
        ["reconcile", "absent"],
      ],
    ],
  );
  assert.deepEqual(
    adapter.calls.filter((call) => !call.startsWith("reconcile")),
    [],
  );
  await authority.close();
});

await test("CLV-049 a drop of a run with a sent start sends one stop request for the start, the confirmed stop is in the stops of the run, and a later worker report does not remove it", async () => {
  const started = await scene(stopped);
  const { authority, adapter } = started;
  assert.equal((await executePinned(authority, start)).kind, "accepted");
  await deliverUntil(
    authority,
    async () => (await authority.eligibleIntents()).length === 0,
  );
  await authority.execute(
    { ...drop, expectedRevision: 1 },
    { recordedAt: noon },
  );
  await deliverUntil(
    authority,
    async () =>
      (await authority.effects.closure("run-1")).closure === "cancelled",
  );
  assert.deepEqual(stops(adapter.calls), ["stop start-run 0"]);
  const [record] = await authority.operations();
  assert.ok(record);
  assert.deepEqual(await authority.effects.stops("run-1"), [
    record.operationId,
  ]);
  const report = await authority.execute(
    {
      kind: "report-observation",
      commandId: "c-observed",
      runId: "run-1",
      condition: "working",
      reason: "progress",
    },
    { recordedAt: noon },
  );
  assert.equal(report.kind, "accepted", JSON.stringify(report));
  assert.equal((await authority.effects.closure("run-1")).closure, "cancelled");
  await authority.close();
});

const lost: Reply = () => Promise.reject(new Error("the stop reply is lost"));

type Recorder = Pick<Stopper, "delivery" | "calls">;

function lostStop(reconciled: Reply): Recorder {
  const adapter = stopper(lost);
  return {
    calls: adapter.calls,
    delivery: {
      ...adapter.delivery,
      reconcile: (intent, signal) =>
        intent.purpose === "stop"
          ? reconciled(intent)
          : adapter.delivery.reconcile(intent, signal),
    },
  };
}

const confirmations: readonly (readonly [string, () => Recorder])[] = [
  [
    "a stop reply that says that the work completed",
    () =>
      stopper(() =>
        Promise.resolve({
          kind: "completed",
          receipt: "receipt-run",
          result: "done",
        }),
      ),
  ],
  [
    "a stop reply that says that the work failed",
    () =>
      stopper(() => Promise.resolve({ kind: "failed", reason: "worker-exit" })),
  ],
  [
    "a lost stop reply and a reconciliation that finds the work stopped",
    () => lostStop(stopped),
  ],
];

for (const [title, recorder] of confirmations)
  await test(`CLV-049 the stop of a dropped run with a sent start is confirmed by ${title}, with one stop request`, async () => {
    const adapter = recorder();
    const authority = await openedAuthority(await temporaryDirectory(), {
      delivery: adapter.delivery,
      clock: () => noon,
      timing: fastTiming,
    });
    assert.equal((await executePinned(authority, start)).kind, "accepted");
    await deliverUntil(
      authority,
      async () => (await authority.eligibleIntents()).length === 0,
    );
    await authority.execute(
      { ...drop, expectedRevision: 1 },
      { recordedAt: noon },
    );
    await deliverUntil(
      authority,
      async () =>
        (await authority.effects.closure("run-1")).closure === "cancelled",
    );
    await quiet(authority);
    assert.deepEqual(stops(adapter.calls), ["stop start-run 0"]);
    assert.deepEqual(
      (await authority.operations()).flatMap((record) =>
        record.deliveries.map((item) => [item.purpose, item.outcome]),
      ),
      [
        ["dispatch", "sent"],
        ["stop", "stopped"],
      ],
    );
    await authority.close();
  });
