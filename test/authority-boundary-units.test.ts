import assert from "node:assert/strict";
import { test } from "node:test";
import { deliveryHandler } from "../src/broker/actor/authority-delivery.ts";
import { json, storeReceipt } from "../src/broker/actor/authority-session.ts";
import { adoptionTurn, deliveryTurn } from "../src/broker/actor/turn-state.ts";
import { persistChange } from "../src/storage/domain-changes.ts";
import type { SqlConnection } from "../src/storage/domain-rows.ts";

function stub(answers: {
  readonly get?: unknown;
  readonly all?: readonly unknown[];
}): SqlConnection {
  return {
    run: () => Promise.resolve({}),
    get: () => Promise.resolve(answers.get),
    all: () => Promise.resolve(answers.all ?? []),
  };
}

const change = {
  previous: 1,
  sequence: 2,
  definitions: [],
  events: [],
  runs: [],
  commands: [],
  added: [],
  released: [],
  staged: [],
  closed: [],
};

await test("CLV-042 a domain change that does not continue the stored sequence or has a malformed list is refused", async () => {
  await assert.rejects(
    persistChange(change, stub({ get: { sequence: 2 } })),
    /stale-authority-sequence/,
  );
  await assert.rejects(
    persistChange({ ...change, events: {} }, stub({ get: { sequence: 1 } })),
    /invalid-column: events/,
  );
});

await test("CLV-042 the turn readers refuse an unknown delivery and an adoption that is not pending", async () => {
  assert.equal(
    await deliveryTurn(stub({}), { effectId: "unknown", sequence: 0 }),
    undefined,
  );
  await assert.rejects(
    adoptionTurn(
      stub({ get: { actor_id: "a", adoption_sequence: null, sequence: 0 } }),
    ),
    /adoption-not-pending/,
  );
});

await test("CLV-042 a delivery handler without a delivery adapter refuses to send", async () => {
  const handler = deliveryHandler({
    reader: {
      family: "sqlite",
      schemaIdentity: "stub",
      connection: () => Promise.reject(new Error("no read expected")),
      transaction: () => Promise.reject(new Error("no write expected")),
      close: () => Promise.resolve(),
    },
    delivery: undefined,
    epoch: () => 1,
  });
  await assert.rejects(
    handler(
      {},
      {
        id: "effect-1",
        attempt: 1,
        sourceMessageId: "message-1",
        actorType: "ClovingAuthority",
        actorId: "a",
      },
    ),
    /delivery-unconfigured/,
  );
});

await test("CLV-042 actor receipts and JSON boundaries reject malformed values instead of coercing them", () => {
  assert.deepEqual(storeReceipt({ kind: "rejected", reason: "stale-epoch" }), {
    kind: "rejected",
    reason: "stale-epoch",
  });
  assert.throws(
    () => storeReceipt({ kind: "adopted" }),
    /invalid-receipt: adopted/,
  );
  assert.throws(
    () => storeReceipt({ kind: "accepted", sequence: 1 }),
    /invalid-receipt: intents/,
  );
  assert.throws(() => json([]), /invalid-json-object/);
});
