import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  openAuthority,
  type Authority,
  type Delivery,
} from "../src/broker/actor/authority.ts";
import {
  deliverUntil,
  executePinned,
  externalService,
  fastTiming,
  openedAuthority,
  type ExternalService,
} from "./authority-actor-fixture.ts";
import { fileService, sentRecords } from "./authority-actor-service.ts";
import {
  alterDatabase,
  queryDatabase,
  removeTemporaryDirectories,
  storedGate,
  temporaryDirectory,
  withChild,
} from "./authority-store-fixture.ts";

const admission = storedGate[0] ?? {};
const operationId =
  '["cloving-operation",0,"run-1","admission","start-run",null,null]';

async function outcomes(authority: Authority): Promise<unknown> {
  return (await authority.operations()).map((operation) =>
    operation.deliveries.map((delivery) => [
      delivery.outcome,
      delivery.receipt,
    ]),
  );
}

async function admitted(directory: string): Promise<void> {
  const authority = await openedAuthority(directory);
  assert.equal((await executePinned(authority, admission)).kind, "accepted");
  await authority.close();
}

async function deadLetteredCallback(failure: {
  readonly directory: string;
  readonly service: ExternalService;
}): Promise<void> {
  const { directory, service } = failure;
  await admitted(directory);
  alterDatabase(
    directory,
    "CREATE TRIGGER inject BEFORE UPDATE ON deliveries BEGIN SELECT RAISE(ABORT, 'injected-callback-failure'); END;",
  );
  const failing = await openedAuthority(directory, {
    ...service.options,
    timing: fastTiming,
  });
  const controller = new AbortController();
  const outcome = await Promise.race([
    failing.deliver(controller.signal).then(
      () => "stopped",
      (error: unknown) => String(error),
    ),
    delay(5_000, "not detected", { ref: false }),
  ]);
  controller.abort();
  assert.match(
    outcome,
    /^Error: authority-unavailable: dead-lettered message [0-9a-f-]{36}: injected-callback-failure$/,
  );
  await assert.rejects(failing.state(), /authority-unavailable/);
  await failing.close();
}

await test("CLV-042 a delivery callback whose commit fails is dead-lettered, fails the authority closed, and a later opening retries it once as a stale-epoch result and records the dispatch through reconciliation without a second send", async () => {
  const directory = await temporaryDirectory();
  const service = externalService();
  await deadLetteredCallback({ directory, service });
  const refused = await openAuthority(directory, service.options);
  assert.equal(refused.kind, "refused");
  assert.equal(refused.reason, "unresolved-delivery");
  assert.match(
    refused.detail,
    /^dead-lettered message [0-9a-f-]{36}: injected-callback-failure$/,
  );
  alterDatabase(directory, "DROP TRIGGER inject");
  const repaired = await openedAuthority(directory, service.options);
  assert.deepEqual(await outcomes(repaired), [
    [
      ["stale-epoch", "receipt-1"],
      [null, null],
    ],
  ]);
  await deliverUntil(
    repaired,
    async () => (await repaired.eligibleIntents()).length === 0,
  );
  assert.deepEqual(await outcomes(repaired), [
    [
      ["stale-epoch", "receipt-1"],
      ["sent", "receipt-1"],
    ],
  ]);
  assert.equal(service.sent.length, 1);
  await repaired.close();
});

await test("CLV-042 a dead-lettered delivery callback retried by a direct reopening, before its epoch turn, records the dispatch without a second send", async () => {
  const directory = await temporaryDirectory();
  const service = externalService();
  await deadLetteredCallback({ directory, service });
  alterDatabase(directory, "DROP TRIGGER inject");
  const repaired = await openedAuthority(directory, service.options);
  assert.deepEqual(await outcomes(repaired), [[["sent", "receipt-1"]]]);
  assert.deepEqual(await repaired.eligibleIntents(), []);
  await repaired.close();
  assert.equal(service.sent.length, 1);
});

await test("CLV-042 an adapter receipt that is not an identifier fails the effect instead of the callback, and the next opening reconciles the original send once", async () => {
  const directory = await temporaryDirectory();
  await admitted(directory);
  const sent: string[] = [];
  const reconcile: Delivery["reconcile"] = (intent) =>
    Promise.resolve(
      sent.includes(intent.operationId)
        ? { kind: "accepted", receipt: "receipt-1" }
        : { kind: "absent" },
    );
  const malformed = await openedAuthority(directory, {
    delivery: {
      deliver: (intent) => {
        sent.push(intent.operationId);
        return Promise.resolve({ receipt: "not a receipt!" });
      },
      reconcile,
    },
  });
  await deliverUntil(
    malformed,
    async () =>
      JSON.stringify(await outcomes(malformed)) ===
      JSON.stringify([[["failed", null]]]),
  );
  assert.deepEqual(await malformed.eligibleIntents(), [
    { kind: "start-run", runId: "run-1", operationId },
  ]);
  await malformed.close();
  const recovered = await openedAuthority(directory, {
    delivery: {
      deliver: () => Promise.reject(new Error("no second send expected")),
      reconcile,
    },
  });
  await deliverUntil(
    recovered,
    async () => (await recovered.eligibleIntents()).length === 0,
  );
  assert.deepEqual(await outcomes(recovered), [
    [
      ["failed", null],
      ["sent", "receipt-1"],
    ],
  ]);
  assert.deepEqual(sent, [operationId]);
  await recovered.close();
});

await test("CLV-042 a delivery that throws is attempted once, closed as failed, and staged again by the next opening", async () => {
  const directory = await temporaryDirectory();
  await admitted(directory);
  let calls = 0;
  const delivery: Delivery = {
    deliver: () => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new Error("transient adapter failure"))
        : Promise.resolve({ receipt: "receipt-2" });
    },
    reconcile: () => Promise.resolve({ kind: "absent" }),
  };
  const first = await openedAuthority(directory, { delivery });
  await deliverUntil(
    first,
    async () =>
      JSON.stringify(await outcomes(first)) ===
      JSON.stringify([[["failed", null]]]),
  );
  assert.equal(calls, 1);
  await first.close();
  const second = await openedAuthority(directory, { delivery });
  await deliverUntil(
    second,
    async () => (await second.eligibleIntents()).length === 0,
  );
  assert.equal(calls, 2);
  assert.deepEqual(await outcomes(second), [
    [
      ["failed", null],
      ["sent", "receipt-2"],
    ],
  ]);
  await second.close();
});

await test("CLV-042 a delivery callback for a delivery that is already closed is rejected as stale, and the operation is delivered once through reconciliation", async () => {
  const directory = await temporaryDirectory();
  await withChild(
    "authority-actor-child.ts",
    [directory, "complete-then-stop"],
    async (child) => {
      assert.deepEqual(await child.exited, { code: null, signal: "SIGKILL" });
    },
  );
  alterDatabase(directory, "UPDATE deliveries SET outcome = 'failed'");
  const file = join(directory, "external.log");
  const authority = await openedAuthority(directory, {
    delivery: fileService(file),
    timing: fastTiming,
  });
  await deliverUntil(
    authority,
    async () => (await authority.eligibleIntents()).length === 0,
  );
  assert.deepEqual(await outcomes(authority), [
    [
      ["failed", null],
      ["sent", "receipt-1"],
    ],
  ]);
  await authority.close();
  assert.equal(sentRecords(file).length, 1);
  assert.deepEqual(
    queryDatabase(
      directory,
      "SELECT json_extract(rejection, '$.code') AS code FROM solid_messages WHERE operation = 'deliveryCompleted' ORDER BY created_at_ms",
    ),
    [{ code: "stale_callback" }, { code: null }],
  );
});

after(removeTemporaryDirectories);
