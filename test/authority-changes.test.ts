import assert from "node:assert/strict";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { Authority } from "../src/broker/actor/authority.ts";
import {
  sequenceChanges,
  subscriptions,
} from "../src/broker/actor/authority-changes.ts";
import {
  deliverUntil,
  executePinned,
  externalService,
  openedAuthority,
} from "./authority-actor-fixture.ts";
import {
  removeTemporaryDirectories,
  storedGate,
  temporaryDirectory,
} from "./authority-store-fixture.ts";

after(removeTemporaryDirectories);

const [admission = {}, started = {}] = storedGate;

async function latest(authority: Authority): Promise<number> {
  return (await authority.queries.eventsAfter({ after: 0, limit: 1 })).latest;
}

function settled(
  authority: Authority,
  seen: readonly number[],
): () => Promise<boolean> {
  return async () =>
    (await authority.eligibleIntents()).length === 0 &&
    seen.at(-1) === (await latest(authority));
}

await test("CLV-016 the authority publishes its event sequence with each committed turn, and a subscriber of the session gets each new sequence one time while the delivery loop runs", async () => {
  const directory = await temporaryDirectory();
  const authority = await openedAuthority(directory, externalService().options);
  const seen: number[] = [];
  authority.changes.subscribe((sequence) => {
    seen.push(sequence);
  });
  assert.equal((await executePinned(authority, admission)).kind, "accepted");
  await deliverUntil(authority, settled(authority, seen));
  assert.ok((await latest(authority)) > 1, JSON.stringify(seen));
  assert.deepEqual(
    seen,
    [...new Set(seen)].toSorted((a, b) => a - b),
  );
  await authority.close();
});

await test("CLV-016 a subscriber gets the present sequence with no delivery loop, a closed subscription gets no more sequences, and the close of the authority closes each subscription", async () => {
  const directory = await temporaryDirectory();
  const first = await openedAuthority(directory);
  assert.equal((await executePinned(first, admission)).kind, "accepted");
  const present: number[] = [];
  first.changes.subscribe((sequence) => {
    present.push(sequence);
  });
  for (let waited = 0; present.length === 0 && waited < 200; waited += 1)
    await delay(10);
  assert.deepEqual(present, [1]);
  await first.close();
  const authority = await openedAuthority(directory, externalService().options);
  const kept: number[] = [];
  const closed: number[] = [];
  authority.changes.subscribe((sequence) => {
    kept.push(sequence);
  });
  const close = authority.changes.subscribe((sequence) => {
    closed.push(sequence);
  });
  await deliverUntil(authority, settled(authority, kept));
  const before = [...closed];
  close();
  const expectedRevision = (await authority.state()).runs["run-1"]?.revision;
  const next = { ...started, expectedRevision };
  assert.equal((await executePinned(authority, next)).kind, "accepted");
  await deliverUntil(authority, settled(authority, kept));
  assert.deepEqual(closed, before);
  assert.ok(kept.length > before.length, JSON.stringify({ kept, before }));
  await authority.close();
  assert.deepEqual(present, [1]);
});

function session(outcome: Promise<void>): {
  readonly sent: (envelope: Readonly<Record<string, unknown>>) => void;
  readonly log: unknown[];
  readonly seen: number[];
} {
  const log: unknown[] = [];
  const seen: number[] = [];
  const handlers: ((envelope: { readonly kind: string }) => void)[] = [];
  sequenceChanges(
    {
      broker: log,
      actorType: "ClovingAuthority",
      actorId: "authority",
      realtime: {
        connect: (options) => {
          handlers.push(options.send);
          log.push(options.authorizationContext === log);
          return {
            receive: (request) => {
              log.push(request);
              return outcome;
            },
            close: () => {
              log.push("closed");
            },
          };
        },
      },
    },
    (sequence) => {
      seen.push(sequence);
    },
  );
  return {
    log,
    seen,
    sent: (envelope) => {
      handlers[0]?.({ kind: "invalidation", ...envelope });
    },
  };
}

await test("CLV-016 a subscription asks for the authority actor with the broker context, gives only a sequence number that is higher than the last one, and closes its session when the request fails", async () => {
  const open = session(Promise.resolve());
  assert.deepEqual(open.log, [
    true,
    {
      version: 1,
      action: "subscribe",
      actorType: "ClovingAuthority",
      actorId: "authority",
    },
  ]);
  for (const envelope of [
    { observables: { sequence: 2 } },
    { observables: { sequence: 2 } },
    { observables: { sequence: 1 } },
    { observables: { sequence: "3" } },
    { observables: {} },
    { kind: "payload" },
    { observables: { sequence: 4 } },
  ])
    open.sent(envelope);
  assert.deepEqual(open.seen, [2, 4]);
  const refused = session(Promise.reject(new Error("not authorized")));
  await delay(10);
  assert.equal(refused.log.at(-1), "closed");
  assert.deepEqual(refused.seen, []);
});

await test("CLV-016 the subscriptions of a session close one time each: one by its own close, the others by the close of the session", () => {
  const closed: number[] = [];
  const all = subscriptions(() => {
    const index = closed.length;
    closed.push(0);
    return () => {
      closed[index] = (closed[index] ?? 0) + 1;
    };
  });
  const listener = (): void => undefined;
  const first = all.add(listener);
  all.add(listener);
  first();
  all.close();
  all.close();
  assert.deepEqual(closed, [1, 1]);
});
