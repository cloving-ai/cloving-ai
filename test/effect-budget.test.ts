import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { Authority } from "../src/broker/actor/authority.ts";
import {
  deliverUntil,
  fastTiming,
  openedAuthority,
} from "./authority-actor-fixture.ts";
import {
  manifest,
  removeTemporaryDirectories,
  storedGate,
  temporaryDirectory,
} from "./authority-store-fixture.ts";
import {
  effectReport,
  effectRequest,
  fakeDestination,
  inputDigest,
  noon,
  runningRun,
  sender,
  type Destination,
  type Request,
  type Send,
} from "./effect-fixture.ts";

after(removeTemporaryDirectories);

interface Scene {
  readonly authority: Authority;
  readonly destination: Destination;
  readonly directory: string;
  readonly send: Send;
}

async function reopened(
  directory: string,
  destination: Destination,
): Promise<Scene> {
  const authority = await openedAuthority(directory, {
    delivery: destination.delivery,
    clock: () => noon,
    timing: fastTiming,
  });
  return {
    authority,
    destination,
    directory,
    send: sender(authority, { now: noon }),
  };
}

async function scene(effectLimit: number): Promise<Scene> {
  const started = await reopened(await temporaryDirectory(), fakeDestination());
  await runningRun(started.send, { effectLimit });
  return started;
}

function field(value: object, name: string): unknown {
  return Reflect.get(value, name);
}

async function recorded(
  started: Scene,
  request: Request,
): Promise<readonly unknown[]> {
  const receipt = await started.send(request.command, request.documents);
  const stored = await started.authority.effects.disposition(
    Number(field(receipt, "sequence")),
  );
  const operation = await started.authority.effects.operation(
    request.operationId,
  );
  return [
    field(receipt, "disposition"),
    stored?.reason,
    operation?.status,
    operation?.reason,
  ];
}

function settled(authority: Authority): Promise<void> {
  return deliverUntil(
    authority,
    async () => (await authority.eligibleIntents()).length === 0,
  );
}

function unpinned(round: number): Request {
  const request = effectRequest({
    commandId: `c-other-${String(round)}`,
    round,
  });
  const command: Readonly<Record<string, unknown>> = request.command;
  return {
    ...request,
    command: {
      ...command,
      capability: "network",
      inputDigest: inputDigest({
        capability: "network",
        method: String(command["method"]),
        target: String(command["target"]),
        payload: String(command["payload"]),
      }),
    },
  };
}

await test("CLV-049 the service does not send a protected effect with a capability that the run did not pin, and the record has the reason", async () => {
  const started = await scene(5);
  const { authority, destination } = started;
  assert.deepEqual(await recorded(started, unpinned(1)), [
    "refused",
    "unadmitted-capability",
    "refused",
    "unadmitted-capability",
  ]);
  assert.deepEqual(await authority.eligibleIntents(), []);
  assert.deepEqual(
    (await authority.operations()).map((record) => record.kind),
    ["start-run"],
  );
  await settled(authority);
  assert.deepEqual(destination.calls, []);
  assert.deepEqual(await authority.effects.budget("run-1"), {
    runId: "run-1",
    limit: 5,
    spent: 0,
    capabilities: ["fake-harness"],
    exhaustedSequence: null,
  });
  const admitted = effectRequest({ commandId: "c-request", round: 2 });
  assert.equal((await recorded(started, admitted))[0], "admitted");
  await authority.close();
});

await test("CLV-049 a request with 0 units is recorded as an invalid effect request and spends nothing", async () => {
  const started = await scene(5);
  const request = effectRequest({ commandId: "c-request", round: 1, units: 0 });
  assert.deepEqual(await recorded(started, request), [
    "refused",
    "invalid-effect-request",
    "refused",
    "invalid-effect-request",
  ]);
  assert.equal((await started.authority.effects.budget("run-1"))?.spent, 0);
  await started.authority.close();
});

await test("CLV-049 the service does not send an operation above the run budget, the record has the reason, and the run sends no later protected effect", async () => {
  const started = await scene(2);
  const { authority, destination } = started;
  const first = effectRequest({ commandId: "c-1", round: 1 });
  assert.equal((await recorded(started, first))[0], "admitted");
  await settled(authority);
  const above = effectRequest({ commandId: "c-2", round: 2, units: 2 });
  const later = effectRequest({ commandId: "c-3", round: 3 });
  for (const request of [above, later])
    assert.deepEqual(await recorded(started, request), [
      "refused",
      "budget-exhausted",
      "refused",
      "budget-exhausted",
    ]);
  await settled(authority);
  assert.deepEqual(destination.effects, [first.operationId]);
  assert.deepEqual(await authority.effects.budget("run-1"), {
    runId: "run-1",
    limit: 2,
    spent: 1,
    capabilities: ["fake-harness"],
    exhaustedSequence: 6,
  });
  const report = effectReport(first, {
    commandId: "c-report",
    leaseGeneration: 1,
    worker: "worker-1",
    result: "the result",
  });
  const applied = await started.send(report.command, report.documents);
  assert.equal(field(applied, "disposition"), "applied");
  await authority.close();
});

await test("CLV-049 an operation that was admitted and not sent is not sent after the budget of its run is exhausted, and it is cancelled with the reason", async () => {
  const started = await scene(2);
  const { authority, destination } = started;
  const pending = effectRequest({ commandId: "c-1", round: 1 });
  const above = effectRequest({ commandId: "c-2", round: 2, units: 2 });
  assert.equal((await recorded(started, pending))[2], "dispatch-pending");
  assert.equal((await recorded(started, above))[1], "budget-exhausted");
  await deliverUntil(
    authority,
    async () =>
      (await authority.effects.operation(pending.operationId))?.status ===
      "cancelled",
  );
  const operation = await authority.effects.operation(pending.operationId);
  assert.deepEqual(
    [operation?.reason, operation?.leaseGeneration, operation?.receipt],
    ["budget-exhausted", null, null],
  );
  assert.deepEqual(destination.calls, [`reconcile ${pending.operationId}`]);
  assert.deepEqual(destination.effects, []);
  const records = await authority.operations();
  assert.deepEqual(
    records
      .filter((record) => record.operationId === pending.operationId)
      .map((record) => [
        record.releasedSequence !== null,
        record.deliveries.map((item) => item.outcome),
      ]),
    [[true, ["refused"]]],
  );
  await authority.close();
});

await test("CLV-049 a restart keeps the spent value of the run budget, and a retry of an authorized operation spends no second unit", async () => {
  const first = await scene(3);
  const requests = [1, 2].map((round) =>
    effectRequest({ commandId: `c-${String(round)}`, round }),
  );
  for (const request of requests)
    assert.equal((await recorded(first, request))[0], "admitted");
  assert.equal((await first.authority.effects.budget("run-1"))?.spent, 2);
  await first.authority.close();
  const second = await reopened(first.directory, first.destination);
  assert.equal((await second.authority.effects.budget("run-1"))?.spent, 2);
  const retry = effectRequest({ commandId: "c-1-again", round: 1 });
  assert.equal((await recorded(second, retry))[0], "existing");
  assert.equal((await second.authority.effects.budget("run-1"))?.spent, 2);
  const third = effectRequest({ commandId: "c-3", round: 3 });
  const fourth = effectRequest({ commandId: "c-4", round: 4 });
  assert.equal((await recorded(second, third))[0], "admitted");
  assert.deepEqual((await recorded(second, fourth)).slice(0, 2), [
    "refused",
    "budget-exhausted",
  ]);
  assert.deepEqual(
    [
      (await second.authority.effects.budget("run-1"))?.spent,
      await second.authority.effects.budget("run-9"),
    ],
    [3, undefined],
  );
  await second.authority.close();
});

await test("CLV-049 an admission whose capabilities are not the canonical capability list of its manifest is rejected and commits nothing", async () => {
  const authority = await openedAuthority(await temporaryDirectory());
  const send = sender(authority, { now: noon });
  for (const capabilities of ["[]", '["fake-harness","network"]', '["other"]'])
    assert.deepEqual(
      await send({ ...storedGate[0], effectLimit: 2, capabilities }),
      { kind: "rejected", reason: "capability-pin-mismatch" },
      capabilities,
    );
  assert.equal((await authority.events()).length, 0);
  const admitted = await send({
    ...storedGate[0],
    effectLimit: 2,
    capabilities: JSON.stringify(manifest.capabilities),
  });
  assert.equal(admitted.kind, "accepted");
  await authority.close();
});
