import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { Authority, Delivery } from "../src/broker/actor/authority.ts";
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
