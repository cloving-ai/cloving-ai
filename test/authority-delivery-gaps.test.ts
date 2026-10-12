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
  alterDatabase,
  removeTemporaryDirectories,
  storedGate,
  temporaryDirectory,
} from "./authority-store-fixture.ts";

after(removeTemporaryDirectories);

interface Recording {
  readonly delivery: Delivery;
  readonly calls: string[];
}

function recording(): Recording {
  const calls: string[] = [];
  const sent: string[] = [];
  return {
    calls,
    delivery: {
      deliver: (intent) => {
        calls.push("deliver");
        sent.push(intent.operationId);
        return Promise.resolve({ receipt: `receipt-${String(sent.length)}` });
      },
      reconcile: (intent) => {
        calls.push("reconcile");
        const index = sent.indexOf(intent.operationId);
        return Promise.resolve(
          index === -1
            ? { kind: "absent" }
            : { kind: "accepted", receipt: `receipt-${String(index + 1)}` },
        );
      },
    },
  };
}

async function admitted(directory: string): Promise<void> {
  const authority = await openedAuthority(directory);
  const receipt = await executePinned(authority, storedGate[0] ?? {});
  assert.equal(receipt.kind, "accepted");
  await authority.close();
}

for (const [name, change, expected] of [
  [
    "that is closed",
    "UPDATE deliveries SET outcome = 'failed'",
    ["failed", "sent"],
  ],
  [
    "whose stored digest differs from the digest of its arguments",
    `UPDATE deliveries SET input_digest = '${"0".repeat(64)}'`,
    [null],
  ],
  [
    "whose arguments differ from their digest",
    "UPDATE solid_effects SET arguments = json_set(arguments, '$.runId', 'run-2')",
    ["withheld", "sent"],
  ],
] as const)
  await test(`CLV-049 a delivery row ${name} gets no adapter call`, async () => {
    const directory = await temporaryDirectory();
    await admitted(directory);
    alterDatabase(directory, change);
    const adapter = recording();
    const authority = await openedAuthority(directory, {
      delivery: adapter.delivery,
      timing: fastTiming,
    });
    const stale = adapter.calls.length;
    await deliverUntil(authority, async () => {
      const [record] = await authority.operations();
      return (
        record?.deliveries.length === expected.length &&
        record.deliveries.at(-1)?.outcome === expected.at(-1)
      );
    });
    let rounds = 0;
    await deliverUntil(authority, () => {
      rounds += 1;
      return Promise.resolve(rounds > 25);
    });
    const [record] = await authority.operations();
    assert.deepEqual(
      record?.deliveries.map((item) => item.outcome),
      expected,
    );
    assert.deepEqual(
      adapter.calls.slice(stale),
      expected.some((outcome) => outcome === "sent")
        ? ["reconcile", "deliver"]
        : [],
    );
    await authority.close();
  });

function slowFirstStart(slow: {
  readonly held: Promise<{ readonly receipt: string }>;
  readonly signals: AbortSignal[];
  readonly sent: string[];
}): Delivery {
  return {
    reconcile: () => Promise.resolve({ kind: "absent" }),
    deliver: (intent, signal) => {
      if (intent.runId !== "run-1") {
        slow.sent.push(intent.runId);
        return Promise.resolve({ receipt: "receipt-2" });
      }
      slow.signals.push(signal);
      return slow.held;
    },
  };
}

await test("CLV-049 an adapter call of a start above its time limit closes its attempt as failed, its signal is aborted, and it does not hold the dispatch of a second run", async () => {
  const held = Promise.withResolvers<{ readonly receipt: string }>();
  const signals: AbortSignal[] = [];
  const sent: string[] = [];
  const delivery = slowFirstStart({ held: held.promise, signals, sent });
  const authority = await openedAuthority(await temporaryDirectory(), {
    delivery,
    timing: fastTiming,
    effects: { adapterMilliseconds: 80, deliveryAttempts: 1 },
  });
  try {
    for (const runId of ["run-1", "run-2"]) {
      const receipt = await executePinned(authority, {
        ...storedGate[0],
        runId,
        commandId: `c-${runId}`,
      });
      assert.equal(receipt.kind, "accepted");
    }
    await deliverUntil(authority, async () => {
      const records = await authority.operations();
      return records.every((record) => record.deliveries[0]?.outcome != null);
    });
    assert.deepEqual(
      (await authority.operations()).map((record) => [
        record.runId,
        record.deliveries.map((item) => item.outcome),
      ]),
      [
        ["run-1", ["failed"]],
        ["run-2", ["sent"]],
      ],
    );
    assert.deepEqual(sent, ["run-2"]);
    assert.deepEqual(
      signals.map((signal) => signal.aborted),
      [true],
    );
  } finally {
    held.resolve({ receipt: "late" });
    await authority.close();
  }
});
