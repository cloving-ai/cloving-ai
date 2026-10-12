import assert from "node:assert/strict";
import { after, test } from "node:test";
import type {
  AdapterOutcome,
  Authority,
  Delivery,
  DeliveryIntent,
} from "../src/broker/actor/authority.ts";
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
import { effectRequest, noon, runningRun, sender } from "./effect-fixture.ts";
import { drop, quiet, stopper } from "./effect-stop-fixture.ts";

after(removeTemporaryDirectories);

class Harness implements Delivery {
  readonly calls: string[] = [];
  readonly accepted = new Set<string>();

  deliver(intent: DeliveryIntent): Promise<AdapterOutcome> {
    this.calls.push(`deliver ${intent.kind}`);
    this.accepted.add(intent.operationId);
    return Promise.resolve(this.acceptance());
  }

  reconcile(intent: DeliveryIntent): Promise<AdapterOutcome> {
    this.calls.push(`reconcile ${intent.kind} ${intent.purpose}`);
    return Promise.resolve(
      this.accepted.has(intent.operationId)
        ? this.acceptance()
        : { kind: "absent" },
    );
  }

  stop(intent: DeliveryIntent): Promise<AdapterOutcome> {
    this.calls.push(`stop ${intent.kind}`);
    this.accepted.delete(intent.operationId);
    return Promise.resolve({ kind: "stopped" });
  }

  acceptance(): AdapterOutcome {
    return {
      kind: "accepted",
      receipt: `receipt-${String(this.accepted.size)}`,
      worker: "worker-1",
    };
  }
}

async function rows(authority: Authority): Promise<readonly unknown[]> {
  return (await authority.operations()).map((record) => [
    record.kind,
    record.deliveries.map((item) => [item.purpose, item.outcome]),
  ]);
}

await test("CLV-049 an adapter that is an object of a class gets each call for a protected effect with its receiver: the send and the stop request of a dropped run", async () => {
  const adapter = new Harness();
  const authority = await openedAuthority(await temporaryDirectory(), {
    delivery: adapter,
    clock: () => noon,
    timing: fastTiming,
  });
  const send = sender(authority, { now: noon });
  await runningRun(send, { effectLimit: 5 });
  const request = effectRequest({ commandId: "c-1", round: 1 });
  await send(request.command, request.documents);
  await quiet(authority);
  assert.deepEqual(await rows(authority), [
    ["start-run", [["dispatch", "withheld"]]],
    ["protected-effect", [["dispatch", "accepted"]]],
  ]);
  assert.equal((await send(drop)).kind, "accepted");
  await quiet(authority);
  assert.deepEqual(await rows(authority), [
    ["start-run", [["dispatch", "withheld"]]],
    [
      "protected-effect",
      [
        ["dispatch", "accepted"],
        ["stop", "stopped"],
      ],
    ],
  ]);
  assert.deepEqual(
    adapter.calls.filter((call) => call.startsWith("stop")),
    ["stop protected-effect"],
  );
  assert.equal((await authority.effects.closure("run-1")).closure, "cancelled");
  await authority.close();
});

const start = storedGate[0] ?? {};

await test("CLV-049 an adapter that is an object of a class gets the stop request for a sent start of a dropped run with its receiver", async () => {
  const adapter = new Harness();
  const authority = await openedAuthority(await temporaryDirectory(), {
    delivery: adapter,
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
  await quiet(authority);
  assert.deepEqual(await rows(authority), [
    [
      "start-run",
      [
        ["dispatch", "sent"],
        ["stop", "stopped"],
      ],
    ],
  ]);
  assert.deepEqual(
    adapter.calls.filter((call) => call.startsWith("stop")),
    ["stop start-run"],
  );
  assert.equal((await authority.effects.closure("run-1")).closure, "cancelled");
  await authority.close();
});

function formed(kind: unknown): AdapterOutcome {
  return Object.assign(
    { kind: "unknown" as const },
    Object.fromEntries([["kind", kind]]),
  );
}

interface Misformed {
  readonly delivery: Delivery;
  readonly calls: string[];
  readonly dropped: { now: boolean };
}

function misformed(member: "stop" | "reconcile", kind: unknown): Misformed {
  const adapter = stopper(() =>
    Promise.resolve(member === "stop" ? formed(kind) : { kind: "unknown" }),
  );
  const dropped = { now: false };
  return {
    calls: adapter.calls,
    dropped,
    delivery: {
      ...adapter.delivery,
      reconcile: (intent, signal) =>
        dropped.now && member === "reconcile"
          ? Promise.resolve(formed(kind))
          : adapter.delivery.reconcile(intent, signal),
    },
  };
}

for (const member of ["stop", "reconcile"] as const)
  for (const [name, kind] of [
    ["a list with the text stopped", ["stopped"]],
    ["a list with the text completed", ["completed"]],
    ["an object with the text form failed", { toString: () => "failed" }],
  ] as const)
    await test(`CLV-049 a ${member} reply for a start of a dropped run whose kind is ${name} is an unknown outcome and confirms no stop`, async () => {
      const adapter = misformed(member, kind);
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
      adapter.dropped.now = true;
      await authority.execute(
        { ...drop, expectedRevision: 1 },
        { recordedAt: noon },
      );
      await quiet(authority);
      const outcome = { stop: "sent", reconcile: "unknown" }[member];
      assert.deepEqual(await rows(authority), [
        [
          "start-run",
          [
            ["dispatch", "sent"],
            ["stop", outcome],
            ["stop", outcome],
            ["stop", outcome],
          ],
        ],
      ]);
      assert.deepEqual(await authority.effects.closure("run-1"), {
        closure: "stop-unconfirmed",
        unresolved: [],
        open: false,
      });
      assert.deepEqual(await authority.effects.stops("run-1"), []);
      await authority.close();
    });
