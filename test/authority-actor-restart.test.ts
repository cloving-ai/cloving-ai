import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  deliverUntil,
  executePinned,
  fastTiming,
  openedAuthority,
  storedCounts,
} from "./authority-actor-fixture.ts";
import { fileService, sentRecords } from "./authority-actor-service.ts";
import {
  manifest,
  pin,
  removeTemporaryDirectories,
  storedGate,
  temporaryDirectory,
  withChild,
} from "./authority-store-fixture.ts";

const admission = storedGate[0] ?? {};
const start = {
  kind: "start-run",
  runId: "run-1",
  operationId:
    '["cloving-operation",0,"run-1","admission","start-run",null,null]',
};
const duplicate = { kind: "duplicate", sequence: 1, intents: [start] };

async function settled(directory: string): Promise<readonly unknown[]> {
  const file = join(directory, "external.log");
  const authority = await openedAuthority(directory, {
    delivery: fileService(file),
    timing: fastTiming,
  });
  await deliverUntil(
    authority,
    async () => (await authority.eligibleIntents()).length === 0,
  );
  assert.deepEqual(await executePinned(authority, admission), duplicate);
  const events = (await authority.events()).map((event) => [
    event.sequence,
    event.type,
    event.payload,
  ]);
  await authority.close();
  return events;
}

await test("CLV-042 a command whose reply is lost returns its original receipt, pinned manifest and operation identity after a restart, and one delivery follows", async () => {
  const directory = await temporaryDirectory();
  await withChild(
    { script: "authority-actor-child.ts", parameters: [directory, "commit"] },
    async (child) => {
      await child.waitFor("awaiting-dispatch");
      assert.deepEqual(await child.kill(), { code: null, signal: "SIGKILL" });
    },
  );
  const file = join(directory, "external.log");
  const authority = await openedAuthority(directory, {
    delivery: fileService(file),
    timing: fastTiming,
  });
  assert.deepEqual(await executePinned(authority, admission), duplicate);
  assert.deepEqual(await authority.resumePinned("run-1", manifest), {
    kind: "admitted",
    manifest,
  });
  await authority.close();
  assert.deepEqual(storedCounts(directory)["deliveries"], [{ count: 1 }]);
  assert.deepEqual(sentRecords(file), []);
  assert.deepEqual(await settled(directory), [
    [1, "run.created", { workflow: pin }],
    [
      2,
      "step.dispatched",
      { operationId: start.operationId, receipt: "receipt-1" },
    ],
  ]);
  assert.deepEqual(sentRecords(file), [
    { operationId: start.operationId, workflow: pin, receipt: "receipt-1" },
  ]);
});

await test("CLV-042 an effect interrupted after external acceptance reconciles after a restart and records the original receipt without a second send", async () => {
  const directory = await temporaryDirectory();
  await withChild(
    {
      script: "authority-actor-child.ts",
      parameters: [directory, "send-then-hang"],
    },
    async (child) => {
      await child.waitFor("externally-accepted receipt-1");
      assert.deepEqual(await child.kill(), { code: null, signal: "SIGKILL" });
    },
  );
  assert.deepEqual(await settled(directory), [
    [1, "run.created", { workflow: pin }],
    [
      2,
      "step.dispatched",
      { operationId: start.operationId, receipt: "receipt-1" },
    ],
  ]);
  assert.equal(sentRecords(join(directory, "external.log")).length, 1);
});

await test("CLV-042 a delivery callback left by a process that stops before its turn is applied once after a restart without a second send", async () => {
  const directory = await temporaryDirectory();
  await withChild(
    {
      script: "authority-actor-child.ts",
      parameters: [directory, "complete-then-stop"],
    },
    async (child) => {
      assert.deepEqual(await child.exited, { code: null, signal: "SIGKILL" });
    },
  );
  const file = join(directory, "external.log");
  assert.equal(sentRecords(file).length, 1);
  assert.deepEqual(storedCounts(directory)["events"], [{ count: 1 }]);
  assert.deepEqual(await settled(directory), [
    [1, "run.created", { workflow: pin }],
    [
      2,
      "step.dispatched",
      { operationId: start.operationId, receipt: "receipt-1" },
    ],
  ]);
  assert.equal(sentRecords(file).length, 1);
});

after(removeTemporaryDirectories);
