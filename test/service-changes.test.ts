import assert from "node:assert/strict";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { follow } from "../src/cli/client.ts";
import { changeSignal } from "../src/service/changes.ts";
import { events } from "../src/service/event-handler.ts";
import { commandGateway } from "../src/service/gateway.ts";
import { workflowRegistry } from "../src/service/registry.ts";
import { executePinned, openedAuthority } from "./authority-actor-fixture.ts";
import {
  removeTemporaryDirectories,
  storedGate,
  temporaryDirectory,
} from "./authority-store-fixture.ts";
import { startedRun, testTiming, withHarness } from "./service-fixture.ts";

after(removeTemporaryDirectories);

type Listener = (sequence: number) => void;

function source(): {
  readonly publish: Listener;
  readonly subscribe: (listener: Listener) => () => void;
  readonly closed: () => number;
} {
  const listeners = new Set<Listener>();
  let closed = 0;
  return {
    publish: (sequence) => {
      for (const listener of listeners) listener(sequence);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        closed += 1;
      };
    },
    closed: () => closed,
  };
}

async function settledIn(
  wait: Promise<void>,
  milliseconds: number,
): Promise<string> {
  const late = delay(milliseconds).then(() => "pending");
  return Promise.race([wait.then(() => "settled"), late]);
}

await test("CLV-016 the change signal of the service ends a wait at once for a sequence that was published before, at the next published sequence, at the end of the wait time, and at its close", async () => {
  const published = source();
  const signal = changeSignal(published.subscribe);
  published.publish(5);
  assert.equal(
    await settledIn(signal.next({ after: 3, milliseconds: 60_000 }), 50),
    "settled",
  );
  const waiting = signal.next({ after: 5, milliseconds: 60_000 });
  assert.equal(await settledIn(waiting, 50), "pending");
  published.publish(6);
  assert.equal(await settledIn(waiting, 50), "settled");
  assert.equal(
    await settledIn(signal.next({ after: 6, milliseconds: 20 }), 500),
    "settled",
  );
  const open = signal.next({ after: 6, milliseconds: 60_000 });
  signal.close();
  assert.equal(await settledIn(open, 50), "settled");
  assert.equal(published.closed(), 1);
  assert.equal(
    await settledIn(signal.next({ after: 9, milliseconds: 60_000 }), 50),
    "settled",
  );
});

await test("CLV-016 a follow of the events of one run waits for a sequence above the newest sequence of all runs, so the events of a different run cause no loop, and a service with no change signal waits for its follow time", async () => {
  const authority = await openedAuthority(await temporaryDirectory());
  const [admission = {}] = storedGate;
  const second = { ...admission, commandId: "c-9", runId: "run-2" };
  assert.equal((await executePinned(authority, admission)).kind, "accepted");
  assert.equal((await executePinned(authority, second)).kind, "accepted");
  const registry = workflowRegistry([]);
  const clock = (): string => "2026-10-10T12:00:00.000Z";
  const context = {
    authority,
    registry,
    gateway: commandGateway({ authority, registry, clock, textBytes: 1000 }),
    clock,
    livenessMilliseconds: 1,
    followMilliseconds: 20,
    resolverMilliseconds: 1000,
    textBytes: 1000,
    documentBytes: 1000,
  };
  const parameters = { runId: "run-1", after: 1, follow: true };
  const waits: unknown[] = [];
  const signalled = await events(
    {
      ...context,
      changed: (wait) => {
        waits.push(wait);
        return Promise.resolve();
      },
    },
    {
      parameters,
      connection: {
        send: () => Promise.resolve(true),
        closed: () => waits.length > 0,
      },
    },
  );
  const reads: number[] = [];
  const started = Date.now();
  const timed = await events(context, {
    parameters,
    connection: {
      send: (page) => Promise.resolve(reads.push(page.length) > 0),
      closed: () => reads.length > 1,
    },
  });
  await authority.close();
  assert.deepEqual([signalled, timed, reads], [undefined, undefined, [0, 0]]);
  assert.deepEqual(waits, [{ after: 2, milliseconds: 20 }]);
  assert.ok(Date.now() - started >= 20);
});

await test("CLV-016 a follow of the events gets a new event at once through the subscription of the authority, also when the follow wait of the service is one minute", () =>
  withHarness(async (harness) => {
    const service = await harness.start({
      timing: { ...testTiming, followMilliseconds: 60_000 },
    });
    const seen: unknown[] = [];
    const stop = Promise.withResolvers<undefined>();
    const following = follow(harness.runtimeDirectory, {
      request: { operation: "events", parameters: { after: 0, follow: true } },
      onEvent: (event) => {
        seen.push(event["type"]);
      },
      signal: stop.promise.then(() => undefined),
    });
    await delay(300);
    const started = Date.now();
    await startedRun(harness, { service, commandId: "c-1" });
    while (seen.length < 2 && Date.now() - started < 5_000) await delay(10);
    stop.resolve(undefined);
    await following;
    assert.ok(seen.includes("run.created"), JSON.stringify(seen));
    assert.ok(seen.includes("run.started"), JSON.stringify(seen));
    await service.close();
  }));
