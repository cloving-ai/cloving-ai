import assert from "node:assert/strict";
import { after, test } from "node:test";
import type {
  Authority,
  AuthorityOptions,
  Delivery,
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

after(removeTemporaryDirectories);

const start = storedGate[0] ?? {};

function failingStarts(): { readonly delivery: Delivery; count: number } {
  const adapter = {
    count: 0,
    delivery: {
      reconcile: () => Promise.resolve({ kind: "absent" as const }),
      deliver: () => {
        adapter.count += 1;
        return Promise.reject(new Error("transient adapter failure"));
      },
    },
  };
  return adapter;
}

async function outcomes(authority: Authority): Promise<readonly unknown[]> {
  return (await authority.operations()).flatMap((record) =>
    record.deliveries.map((item) => item.outcome),
  );
}

async function quiet(authority: Authority): Promise<void> {
  let rounds = 0;
  await deliverUntil(authority, () => {
    rounds += 1;
    return Promise.resolve(rounds > 20);
  });
}

const recorded = { recordedAt: "2026-10-10T12:00:00.000Z" };

function firstSendOfEachFails(): {
  readonly delivery: Delivery;
  readonly sends: string[];
} {
  const sends: string[] = [];
  return {
    sends,
    delivery: {
      reconcile: () => Promise.resolve({ kind: "absent" as const }),
      deliver: (intent) => {
        sends.push(intent.operationId);
        const count = sends.filter((id) => id === intent.operationId).length;
        return count === 1
          ? Promise.reject(new Error("transient adapter failure"))
          : Promise.resolve({ receipt: `receipt-${String(sends.length)}` });
      },
    },
  };
}

function firstFailureRecordStalled(
  events: string[],
): NonNullable<AuthorityOptions["instrumentation"]> {
  let stalled = false;
  return (event) => {
    events.push(event.name);
    if (event.name !== "solid_objects.message.started") return;
    if (stalled || event.attributes["operation"] !== "deliveryFailed") return;
    stalled = true;
    const until = performance.now() + 400;
    while (performance.now() < until);
  };
}

await test("CLV-049 a withheld attempt of a start uses none of the delivery attempts of the opening: the failed delivery after it is tried again one time", async () => {
  const adapter = failingStarts();
  const authority = await openedAuthority(await temporaryDirectory(), {
    delivery: adapter.delivery,
    timing: fastTiming,
  });
  assert.equal((await executePinned(authority, start)).kind, "accepted");
  const paused = await authority.execute(
    {
      kind: "pause-run",
      commandId: "c-pause",
      runId: "run-1",
      expectedRevision: 1,
    },
    recorded,
  );
  assert.equal(paused.kind, "accepted", JSON.stringify(paused));
  await deliverUntil(
    authority,
    async () => (await outcomes(authority)).at(-1) === "withheld",
  );
  const resumed = await executePinned(authority, {
    kind: "resume-run",
    commandId: "c-resume",
    runId: "run-1",
    expectedRevision: 2,
  });
  assert.equal(resumed.kind, "accepted", JSON.stringify(resumed));
  await deliverUntil(authority, () => Promise.resolve(adapter.count === 2));
  await quiet(authority);
  assert.deepEqual(await outcomes(authority), ["withheld", "failed", "failed"]);
  assert.equal(adapter.count, 2);
  await authority.close();
});

await test("CLV-052 a failed delivery whose record turn loses its activation and runs two times is counted one time, and the send is tried again one time", async () => {
  const adapter = firstSendOfEachFails();
  const events: string[] = [];
  const authority = await openedAuthority(await temporaryDirectory(), {
    delivery: adapter.delivery,
    timing: {
      ...fastTiming,
      leaseMilliseconds: 100,
      renewalMilliseconds: 30,
    },
    instrumentation: firstFailureRecordStalled(events),
  });
  assert.equal((await executePinned(authority, start)).kind, "accepted");
  await deliverUntil(
    authority,
    async () => (await authority.eligibleIntents()).length === 0,
  );
  assert.equal(
    events.filter((name) => name === "solid_objects.activation.lost").length,
    1,
  );
  assert.equal(adapter.sends.length, 2);
  assert.deepEqual(await outcomes(authority), ["failed", "sent"]);
  await authority.close();
});

await test("CLV-052 the failed deliveries of two operations are counted for each operation, and each send is tried again one time", async () => {
  const adapter = firstSendOfEachFails();
  const authority = await openedAuthority(await temporaryDirectory(), {
    delivery: adapter.delivery,
    timing: fastTiming,
  });
  for (const runId of ["run-1", "run-2"]) {
    const admitted = { ...start, runId, commandId: `c-admit-${runId}` };
    assert.equal((await executePinned(authority, admitted)).kind, "accepted");
  }
  await deliverUntil(
    authority,
    async () => (await authority.eligibleIntents()).length === 0,
  );
  assert.equal(adapter.sends.length, 4);
  assert.deepEqual(await outcomes(authority), [
    "failed",
    "sent",
    "failed",
    "sent",
  ]);
  await authority.close();
});
