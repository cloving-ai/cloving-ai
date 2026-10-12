import assert from "node:assert/strict";
import { after, test } from "node:test";
import type {
  AdapterOutcome,
  Authority,
  AuthorityOptions,
  Delivery,
} from "../src/broker/actor/authority.ts";
import {
  deliverUntil,
  fastTiming,
  openedAuthority,
} from "./authority-actor-fixture.ts";
import {
  manifest,
  removeTemporaryDirectories,
  temporaryDirectory,
} from "./authority-store-fixture.ts";
import {
  effectRequest,
  fakeDestination,
  noon,
  runningRun,
  sender,
  type Send,
} from "./effect-fixture.ts";

after(removeTemporaryDirectories);

const first = effectRequest({
  commandId: "c-request",
  round: 1,
  runId: "run-1",
});

const observation = {
  kind: "report-observation",
  commandId: "c-observe",
  runId: "run-2",
  condition: "working",
  reason: "progress",
  operationId: first.operationId,
};

interface Scene {
  readonly directory: string;
  readonly authority: Authority;
  readonly send: Send;
}

async function twoRuns(options: AuthorityOptions): Promise<Scene> {
  const directory = await temporaryDirectory();
  const authority = await openedAuthority(directory, {
    clock: () => noon,
    timing: fastTiming,
    ...options,
  });
  const send = sender(authority, { now: noon });
  await runningRun(send, { effectLimit: 5, runId: "run-1" });
  await runningRun(send, { effectLimit: 5, runId: "run-2" });
  await send(first.command, first.documents);
  return { directory, authority, send };
}

async function attempts(authority: Authority): Promise<readonly unknown[]> {
  return (await authority.operations())
    .filter((record) => record.operationId === first.operationId)
    .flatMap((record) =>
      record.deliveries.map((item) => [item.purpose, item.outcome]),
    );
}

function until(
  authority: Authority,
  expected: readonly unknown[],
): Promise<void> {
  const wanted = JSON.stringify(expected);
  return deliverUntil(
    authority,
    async () => JSON.stringify(await attempts(authority)) === wanted,
  );
}

async function observed(scene: Scene): Promise<readonly unknown[]> {
  const receipt = await scene.send(observation);
  const next = await scene.send({
    kind: "pause-run",
    commandId: "c-pause",
    runId: "run-2",
    expectedRevision: 2,
  });
  return [receipt.kind, next.kind, await attempts(scene.authority)];
}

await test("CLV-049 a report of a run that names an operation of a different run with an open attempt gets its usual receipt and stages nothing, also after a new opening", async () => {
  const destination = fakeDestination();
  const scene = await twoRuns({ delivery: destination.delivery });
  const open = [["dispatch", null]];
  assert.deepEqual(await attempts(scene.authority), open);
  assert.deepEqual(await observed(scene), ["accepted", "accepted", open]);
  await scene.authority.close();
  const reopened = await openedAuthority(scene.directory, {
    delivery: destination.delivery,
    clock: () => noon,
    timing: fastTiming,
  });
  const again = await sender(reopened, { now: noon })(observation);
  assert.equal(again.kind, "duplicate", JSON.stringify(again));
  await reopened.close();
});

await test("CLV-049 a request whose source is an operation of a different run is denied, the operation of that run gets no attempt, and a new opening works", async () => {
  const destination = fakeDestination();
  const { directory, authority, send } = await twoRuns({
    delivery: destination.delivery,
  });
  const second = effectRequest({
    commandId: "c-request-2",
    round: 1,
    runId: "run-2",
  });
  const receipt = await send(
    { ...second.command, source: first.operationId, sourceGeneration: 1 },
    second.documents,
  );
  assert.deepEqual(
    [receipt.kind, Reflect.get(receipt, "disposition")],
    ["accepted", "denied"],
    JSON.stringify(receipt),
  );
  assert.equal(
    (
      await authority.effects.disposition(
        Number(Reflect.get(receipt, "sequence")),
      )
    )?.reason,
    "retired-lease-generation",
  );
  assert.equal(
    await authority.effects.operation(second.operationId),
    undefined,
  );
  assert.deepEqual(await attempts(authority), [["dispatch", null]]);
  await authority.close();
  const reopened = await openedAuthority(directory, {
    delivery: destination.delivery,
    clock: () => noon,
    timing: fastTiming,
  });
  await reopened.close();
});

interface Held {
  readonly delivery: Delivery;
  readonly entered: Promise<undefined>;
  readonly release: () => void;
}

const acceptance: AdapterOutcome = {
  kind: "accepted",
  receipt: "receipt-1",
  worker: "worker-1",
};

function heldReconciliation(): Held {
  const entered = Promise.withResolvers<undefined>();
  const gate = Promise.withResolvers<undefined>();
  let launched = false;
  return {
    entered: entered.promise,
    release: () => {
      gate.resolve(undefined);
    },
    delivery: {
      deliver: (intent) => {
        if (intent.kind !== "protected-effect")
          return Promise.resolve({ receipt: "receipt-run" });
        launched = true;
        return Promise.resolve({ kind: "unknown" });
      },
      reconcile: async (intent) => {
        if (intent.kind !== "protected-effect" || !launched)
          return { kind: "absent" };
        entered.resolve(undefined);
        await gate.promise;
        return acceptance;
      },
    },
  };
}

await test("CLV-049 a report of a run that names a recovering operation of a different run with an open reconciliation starts no second reconciliation", async () => {
  const adapter = heldReconciliation();
  const scene = await twoRuns({ delivery: adapter.delivery });
  const settled = until(scene.authority, [
    ["dispatch", "unknown"],
    ["reconcile", "accepted"],
  ]);
  try {
    await adapter.entered;
    const open = [
      ["dispatch", "unknown"],
      ["reconcile", null],
    ];
    assert.deepEqual(await observed(scene), ["accepted", "accepted", open]);
  } finally {
    adapter.release();
  }
  await settled;
  await scene.authority.close();
});

const changed = {
  ...manifest,
  artifacts: { ...manifest.artifacts, "flow.mjs": "f".repeat(64) },
};

await test("CLV-049 a report of a run that names an operation of a different run whose last attempt is blocked by the pin check starts no new dispatch attempt", async () => {
  const destination = fakeDestination();
  const scene = await twoRuns({
    delivery: destination.delivery,
    available: () => changed,
  });
  const last = [["dispatch", "blocked"]];
  await until(scene.authority, last);
  assert.deepEqual(await observed(scene), ["accepted", "accepted", last]);
  assert.deepEqual(destination.effects, []);
  await scene.authority.close();
});
