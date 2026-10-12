import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Authority } from "../src/broker/actor/authority.ts";
import {
  deliverUntil,
  fastTiming,
  openedAuthority,
} from "./authority-actor-fixture.ts";
import {
  alterDatabase,
  queryDatabase,
  removeTemporaryDirectories,
  temporaryDirectory,
  withChild,
} from "./authority-store-fixture.ts";
import {
  destinationRecords,
  effectRequest,
  fileDestination,
  noon,
} from "./effect-fixture.ts";

after(removeTemporaryDirectories);

const { operationId } = effectRequest({ commandId: "c-request", round: 1 });

async function recovered(directory: string): Promise<Authority> {
  const authority = await openedAuthority(directory, {
    delivery: fileDestination(join(directory, "destination.log")),
    clock: () => noon,
    timing: fastTiming,
  });
  await deliverUntil(
    authority,
    async () =>
      (await authority.effects.operation(operationId))?.status === "running",
  );
  return authority;
}

async function recordedOnce(authority: Authority): Promise<readonly unknown[]> {
  const operation = await authority.effects.operation(operationId);
  const records = await authority.operations();
  return [
    operation?.receipt,
    operation?.worker,
    (await authority.events()).filter(
      (event) => event.type === "operation.reconciled",
    ).length,
    records
      .filter((record) => record.operationId === operationId)
      .flatMap((record) => record.deliveries.map((item) => item.outcome)),
  ];
}

await test("CLV-049 a second handler invocation for one effect, after a kill in the first send, reconciles the destination and records the original receipt with no second send", async () => {
  const directory = await temporaryDirectory();
  await withChild(
    { script: "effect-child.ts", parameters: [directory, "send-then-hang"] },
    async (child) => {
      await child.waitFor("externally-accepted");
      assert.deepEqual(await child.kill(), { code: null, signal: "SIGKILL" });
    },
  );
  const authority = await recovered(directory);
  assert.deepEqual(await recordedOnce(authority), [
    "receipt-1",
    "worker-1",
    1,
    ["accepted"],
  ]);
  await authority.close();
  assert.deepEqual(destinationRecords(join(directory, "destination.log")), [
    operationId,
  ]);
});

async function killedAfterTheHandler(directory: string): Promise<void> {
  await withChild(
    {
      script: "effect-child.ts",
      parameters: [directory, "complete-then-stop"],
    },
    async (child) => {
      assert.deepEqual(await child.exited, { code: null, signal: "SIGKILL" });
    },
  );
}

await test("CLV-049 after a kill between the handler return and the callback commit, the next opening applies the stored callback one time: the permanent receipt, one outcome event and one send", async () => {
  const directory = await temporaryDirectory();
  await killedAfterTheHandler(directory);
  assert.deepEqual(
    queryDatabase(
      directory,
      "SELECT d.outcome FROM deliveries d JOIN outbox o ON o.operation_id = d.operation_id WHERE o.kind = 'protected-effect'",
    ),
    [{ outcome: null }],
  );
  const authority = await recovered(directory);
  assert.deepEqual(await recordedOnce(authority), [
    "receipt-1",
    "worker-1",
    1,
    ["accepted"],
  ]);
  assert.equal((await authority.effects.operation(operationId))?.attempts, 0);
  await authority.close();
  assert.deepEqual(destinationRecords(join(directory, "destination.log")), [
    operationId,
  ]);
});

await test("CLV-049 a callback for an attempt row that is closed is rejected as stale and adds no event (the test closes the row with a direct change, because the product has no path to this state)", async () => {
  const directory = await temporaryDirectory();
  await killedAfterTheHandler(directory);
  alterDatabase(
    directory,
    "UPDATE deliveries SET outcome = 'failed' WHERE operation_id IN (SELECT operation_id FROM outbox WHERE kind = 'protected-effect')",
  );
  const authority = await recovered(directory);
  assert.deepEqual(await recordedOnce(authority), [
    "receipt-1",
    "worker-1",
    1,
    ["failed", "accepted"],
  ]);
  await authority.close();
  assert.deepEqual(destinationRecords(join(directory, "destination.log")), [
    operationId,
  ]);
  assert.deepEqual(
    queryDatabase(
      directory,
      "SELECT count(*) AS stale FROM solid_messages WHERE operation = 'deliveryCompleted' AND json_extract(rejection, '$.code') = 'stale_callback'",
    ),
    [{ stale: 1 }],
  );
});

await test("CLV-049 an opening stages no second reconciliation attempt for an operation whose reconciliation attempt is open", async () => {
  const directory = await temporaryDirectory();
  await withChild(
    {
      script: "effect-child.ts",
      parameters: [directory, "stop-in-reconciliation"],
    },
    async (child) => {
      assert.deepEqual(await child.exited, { code: null, signal: "SIGKILL" });
    },
  );
  const authority = await openedAuthority(directory, {
    delivery: {
      deliver: () => Promise.reject(new Error("no send expected")),
      reconcile: () =>
        Promise.resolve({
          kind: "accepted",
          receipt: "receipt-1",
          worker: "worker-1",
        }),
    },
    clock: () => noon,
    timing: fastTiming,
  });
  await deliverUntil(
    authority,
    async () =>
      (await authority.effects.operation(operationId))?.status === "running",
  );
  assert.deepEqual(
    (await authority.operations())
      .filter((record) => record.operationId === operationId)
      .flatMap((record) =>
        record.deliveries.map((item) => [item.purpose, item.outcome]),
      ),
    [
      ["dispatch", "unknown"],
      ["reconcile", "accepted"],
    ],
  );
  await authority.close();
});
