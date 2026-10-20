import { testMilliseconds } from "./test-timing.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import type {
  Authority,
  AuthorityOptions,
} from "../src/broker/actor/authority.ts";
import {
  executePinned,
  externalService,
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
const lost = "solid_objects.activation.lost";
const turnStarted = "solid_objects.message.started";

function admit(
  authority: Authority,
  position: number,
): ReturnType<Authority["execute"]> {
  const runId = `run-${String(position).padStart(4, "0")}`;
  return executePinned(authority, {
    ...start,
    runId,
    commandId: `c-admit-${runId}`,
  });
}

function count(events: readonly string[], name: string): number {
  return events.filter((event) => event === name).length;
}

function slowTurns(
  events: string[],
  milliseconds: number,
): NonNullable<AuthorityOptions["instrumentation"]> {
  return (event) => {
    events.push(event.name);
    if (event.name !== turnStarted) return;
    const until = performance.now() + milliseconds;
    while (performance.now() < until);
  };
}

async function admittedFor(
  authority: Authority,
  milliseconds: number,
): Promise<readonly string[]> {
  const kinds: string[] = [];
  const until = performance.now() + milliseconds;
  for (let position = 0; performance.now() < until; position += 1)
    kinds.push((await admit(authority, position)).kind);
  return kinds;
}

async function withDelivery<T>(
  authority: Authority,
  work: () => Promise<T>,
): Promise<{ readonly result: T; readonly failures: readonly string[] }> {
  const controller = new AbortController();
  const failures: string[] = [];
  const running = authority
    .deliver(controller.signal)
    .catch((error: unknown) => {
      failures.push(String(Reflect.get(Object(error), "message")));
    });
  try {
    return { result: await work(), failures };
  } finally {
    controller.abort();
    await running;
  }
}

await test("CLV-051 a continuous sequence of 30 ms turns for five lease times, with the delivery in progress, loses no activation", async () => {
  const events: string[] = [];
  const timing = {
    ...fastTiming,
    leaseMilliseconds: testMilliseconds(300),
    renewalMilliseconds: testMilliseconds(150),
  };
  const authority = await openedAuthority(await temporaryDirectory(), {
    ...externalService().options,
    timing,
    instrumentation: slowTurns(events, testMilliseconds(30)),
  });
  const { result, failures } = await withDelivery(authority, () =>
    admittedFor(authority, 5 * timing.leaseMilliseconds),
  );
  assert.deepEqual(failures, []);
  assert.equal(count(events, lost), 0);
  assert.deepEqual([...new Set(result)], ["accepted"]);
  assert.equal((await admit(authority, 9_999)).kind, "accepted");
  await authority.close();
});
