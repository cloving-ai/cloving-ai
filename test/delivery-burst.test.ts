import assert from "node:assert/strict";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { Authority, Delivery } from "../src/broker/actor/authority.ts";
import {
  executePinned,
  fastTiming,
  openedAuthority,
} from "./authority-actor-fixture.ts";
import {
  removeTemporaryDirectories,
  storedGate,
  temporaryDirectory,
} from "./authority-store-fixture.ts";
import { noon } from "./effect-fixture.ts";

after(removeTemporaryDirectories);

const start = storedGate[0] ?? {};

const silent: Delivery = {
  reconcile: () => Promise.resolve({ kind: "absent" }),
  deliver: () => Promise.resolve({ receipt: "receipt-1" }),
};

async function droppedRuns(authority: Authority, count: number): Promise<void> {
  for (let made = 0; made < count; made += 1) {
    const runId = `run-${String(made).padStart(4, "0")}`;
    await executePinned(authority, {
      ...start,
      runId,
      commandId: `c-admit-${runId}`,
    });
    await authority.execute(
      {
        kind: "cancel-run",
        commandId: `c-drop-${runId}`,
        runId,
        expectedRevision: 1,
      },
      { recordedAt: noon },
    );
  }
}

async function openRows(authority: Authority): Promise<number> {
  return (await authority.operations()).filter((record) =>
    record.deliveries.some((item) => item.outcome === null),
  ).length;
}

async function burst(authority: Authority): Promise<readonly string[]> {
  const controller = new AbortController();
  const failures: string[] = [];
  const running = authority
    .deliver(controller.signal)
    .catch((error: unknown) => {
      failures.push(String(Reflect.get(Object(error), "message")));
    });
  for (let round = 0; round < 600 && failures.length === 0; round += 1) {
    const open = await openRows(authority).catch(() => -1);
    if (open <= 0) break;
    await delay(50);
  }
  controller.abort();
  await running;
  return failures;
}

await test("CLV-051 a burst of 1 000 withheld deliveries with the fast test timing loses no activation, and the authority stays available", async () => {
  const events: string[] = [];
  const authority = await openedAuthority(await temporaryDirectory(), {
    delivery: silent,
    clock: () => noon,
    timing: fastTiming,
    instrumentation: (event) => {
      events.push(event.name);
    },
  });
  await droppedRuns(authority, 1_000);
  assert.equal(await openRows(authority), 1_000);
  assert.deepEqual(await burst(authority), []);
  assert.deepEqual(
    events.filter((name) => name === "solid_objects.activation.lost"),
    [],
  );
  assert.equal(await openRows(authority), 0);
  const later = await executePinned(authority, {
    ...start,
    runId: "run-later",
    commandId: "c-later",
  });
  assert.equal(later.kind, "accepted");
  await authority.close();
});
