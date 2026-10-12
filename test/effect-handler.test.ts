import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { Authority } from "../src/broker/actor/authority.ts";
import {
  deliverUntil,
  fastTiming,
  openedAuthority,
} from "./authority-actor-fixture.ts";
import {
  alterDatabase,
  removeTemporaryDirectories,
  temporaryDirectory,
} from "./authority-store-fixture.ts";
import {
  effectRequest,
  fakeDestination,
  noon,
  runningRun,
  sender,
  type Request,
} from "./effect-fixture.ts";

after(removeTemporaryDirectories);

const options = { clock: (): string => noon, timing: fastTiming };

async function requested(authority: Authority): Promise<Request> {
  const send = sender(authority, { now: noon });
  await runningRun(send, { effectLimit: 5 });
  const request = effectRequest({ commandId: "c-request", round: 1 });
  const receipt = await send(request.command, request.documents);
  assert.equal(receipt.kind, "accepted", JSON.stringify(receipt));
  return request;
}

async function attempts(
  authority: Authority,
  operationId: string,
): Promise<readonly (string | null)[]> {
  const records = await authority.operations();
  return records
    .filter((record) => record.operationId === operationId)
    .flatMap((record) => record.deliveries.map((item) => item.outcome));
}

const protectedEffects =
  "json_extract(arguments, '$.kind') = 'protected-effect'";

for (const [name, change] of [
  [
    "names a different lease generation",
    `UPDATE solid_effects SET arguments = json_set(arguments, '$.leaseGeneration', 7) WHERE ${protectedEffects}`,
  ],
  [
    "has a payload digest that differs from its input digest",
    `UPDATE solid_effects SET arguments = json_set(arguments, '$.payload', 'sha256:${"9".repeat(64)}') WHERE ${protectedEffects}`,
  ],
] as const)
  await test(`CLV-049 a stored dispatch attempt that ${name} is withheld with no adapter call, and the operation is sent one time with the next lease generation`, async () => {
    const directory = await temporaryDirectory();
    const first = await openedAuthority(directory, options);
    const { operationId } = await requested(first);
    await first.close();
    const destination = fakeDestination();
    alterDatabase(directory, change);
    const authority = await openedAuthority(directory, {
      ...options,
      delivery: destination.delivery,
    });
    await deliverUntil(
      authority,
      async () =>
        (await authority.effects.operation(operationId))?.status === "running",
    );
    assert.deepEqual(destination.calls, [
      `reconcile ${operationId}`,
      `deliver ${operationId}`,
    ]);
    assert.deepEqual(await attempts(authority, operationId), [
      "withheld",
      "accepted",
    ]);
    const operation = await authority.effects.operation(operationId);
    assert.deepEqual(
      [operation?.leaseGeneration, operation?.worker],
      [2, "worker-2"],
    );
    await authority.close();
  });

await test("CLV-049 a stored dispatch attempt with no attempt record is withheld with no adapter call and no event, and a new attempt of the same lease generation sends the operation", async () => {
  const directory = await temporaryDirectory();
  const first = await openedAuthority(directory, options);
  const { operationId } = await requested(first);
  await first.close();
  alterDatabase(directory, "DELETE FROM dispatch_attempts");
  const destination = fakeDestination();
  const authority = await openedAuthority(directory, {
    ...options,
    delivery: destination.delivery,
  });
  await deliverUntil(
    authority,
    async () =>
      (await authority.effects.operation(operationId))?.status === "running",
  );
  assert.deepEqual(destination.calls, [
    `reconcile ${operationId}`,
    `deliver ${operationId}`,
  ]);
  assert.deepEqual(await attempts(authority, operationId), [
    "withheld",
    "accepted",
  ]);
  assert.deepEqual(
    (await authority.events()).map((event) => event.type).slice(2),
    ["effect.requested", "lease.granted", "operation.reconciled"],
  );
  assert.equal(
    (await authority.effects.operation(operationId))?.leaseGeneration,
    1,
  );
  await authority.close();
});

await test("CLV-049 the dispatch attempt of a paused run is withheld with no send, and the operation waits with no lease generation", async () => {
  const destination = fakeDestination();
  const authority = await openedAuthority(await temporaryDirectory(), {
    ...options,
    delivery: destination.delivery,
  });
  const { operationId } = await requested(authority);
  const paused = await sender(authority, { now: noon })({
    kind: "pause-run",
    commandId: "c-pause",
    runId: "run-1",
    expectedRevision: 2,
  });
  assert.equal(paused.kind, "accepted");
  await deliverUntil(
    authority,
    async () =>
      (await authority.effects.operation(operationId))?.status === "waiting",
  );
  const operation = await authority.effects.operation(operationId);
  assert.deepEqual(
    [operation?.reason, operation?.leaseGeneration, operation?.attempts],
    ["run-not-running", null, 0],
  );
  assert.deepEqual(destination.calls, [`reconcile ${operationId}`]);
  assert.deepEqual(await attempts(authority, operationId), ["withheld"]);
  assert.deepEqual(await authority.eligibleIntents(), []);
  await authority.close();
});
