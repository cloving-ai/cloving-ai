import assert from "node:assert/strict";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  openAuthority,
  type Authority,
  type AuthorityOptions,
  type Delivery,
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

const admission = storedGate[0] ?? {};

interface GatedService {
  readonly delivery: Delivery;
  readonly sent: readonly string[];
  readonly entered: Promise<void>;
  readonly release: () => void;
}

function gatedService(): GatedService {
  const sent: string[] = [];
  const returned: string[] = [];
  const entry = Promise.withResolvers<undefined>();
  const gate = Promise.withResolvers<undefined>();
  const receipt = (operationId: string): string =>
    `receipt-${String(sent.indexOf(operationId) + 1)}`;
  return {
    sent,
    entered: entry.promise,
    release: () => {
      gate.resolve(undefined);
    },
    delivery: {
      deliver: async (intent) => {
        sent.push(intent.operationId);
        entry.resolve(undefined);
        await gate.promise;
        returned.push(intent.operationId);
        return { receipt: receipt(intent.operationId) };
      },
      reconcile: (intent) =>
        Promise.resolve(
          returned.includes(intent.operationId)
            ? { kind: "accepted", receipt: receipt(intent.operationId) }
            : { kind: "absent" },
        ),
    },
  };
}

async function admitted(directory: string): Promise<void> {
  const authority = await openedAuthority(directory);
  assert.equal((await executePinned(authority, admission)).kind, "accepted");
  await authority.close();
}

async function reopenedWhenReleased(
  directory: string,
  options: AuthorityOptions,
): Promise<Authority> {
  for (let attempt = 0; ; attempt += 1) {
    const opening = await openAuthority(directory, options);
    if (opening.kind === "opened") return opening.authority;
    assert.equal(opening.reason, "authority-held");
    assert.ok(attempt < 100, "the authority was not released");
    await delay(20);
  }
}

async function handlersSettled(authority: Authority): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const refused = await authority.deliver(AbortSignal.abort()).then(
      () => false,
      () => true,
    );
    if (!refused) return;
    await delay(20);
  }
  assert.fail("the earlier delivery handler did not settle");
}

async function deliveredOnce(
  authority: Authority,
  service: GatedService,
): Promise<void> {
  await deliverUntil(
    authority,
    async () => (await authority.eligibleIntents()).length === 0,
  );
  assert.equal(service.sent.length, 1);
  await authority.close();
}

await test("CLV-042 close waits for an in-flight delivery handler, and a reopening in the same process does not send again", async () => {
  const directory = await temporaryDirectory();
  await admitted(directory);
  const service = gatedService();
  const options = { delivery: service.delivery, timing: fastTiming };
  const authority = await openedAuthority(directory, options);
  const controller = new AbortController();
  const delivering = authority.deliver(controller.signal);
  await service.entered;
  let closed = false;
  const closing = authority.close().then(() => {
    closed = true;
  });
  try {
    await delay(300);
    assert.equal(closed, false);
  } finally {
    service.release();
  }
  await closing;
  await delivering;
  await deliveredOnce(await openedAuthority(directory, options), service);
});

await test("CLV-042 a close whose delivery handler outlasts the shutdown bound reports the timeout after one bound and keeps the authority held until the handler settles", async () => {
  const directory = await temporaryDirectory();
  await admitted(directory);
  const service = gatedService();
  const options = {
    delivery: service.delivery,
    timing: { ...fastTiming, shutdownMilliseconds: 400 },
  };
  const authority = await openedAuthority(directory, options);
  const delivering = authority.deliver(new AbortController().signal);
  await service.entered;
  try {
    const started = performance.now();
    const outcome = await Promise.race([
      authority.close().then(
        () => "closed",
        (error: unknown) => String(error),
      ),
      delay(3_000, "still closing", { ref: false }),
    ]);
    assert.equal(
      outcome,
      "Error: authority-close-timeout: in-flight delivery handlers: 1",
    );
    assert.ok(performance.now() - started < 750);
    await delivering;
    const held = await openAuthority(directory, options);
    assert.equal(held.kind, "refused");
    assert.equal(held.reason, "authority-held");
  } finally {
    service.release();
  }
  await deliveredOnce(await reopenedWhenReleased(directory, options), service);
});

await test("CLV-042 a delivery run is refused while a handler from an earlier run of the same session is still in flight, so the operation is sent once", async () => {
  const directory = await temporaryDirectory();
  await admitted(directory);
  const service = gatedService();
  const authority = await openedAuthority(directory, {
    delivery: service.delivery,
    timing: { ...fastTiming, shutdownMilliseconds: 150 },
  });
  const first = new AbortController();
  const firstRun = authority.deliver(first.signal);
  await service.entered;
  first.abort();
  await firstRun;
  const second = new AbortController();
  try {
    const secondRun = await Promise.race([
      authority.deliver(second.signal).then(
        () => "resolved",
        (error: unknown) => String(error),
      ),
      delay(1_000, "still running", { ref: false }),
    ]);
    assert.equal(secondRun, "Error: delivery-handler-in-flight");
  } finally {
    second.abort();
    service.release();
  }
  await handlersSettled(authority);
  await deliveredOnce(authority, service);
});

after(removeTemporaryDirectories);
