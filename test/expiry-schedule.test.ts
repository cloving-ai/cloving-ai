import assert from "node:assert/strict";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { Authority } from "../src/broker/actor/authority.ts";
import { expiryScan, type ExpiryScan } from "../src/service/expiry.ts";
import { commandGateway } from "../src/service/gateway.ts";
import { workflowRegistry } from "../src/service/registry.ts";
import { serviceTiming } from "../src/service/service.ts";
import {
  deliverUntil,
  fastTiming,
  openedAuthority,
} from "./authority-actor-fixture.ts";
import { preparedDuring } from "./authority-memory-fixture.ts";
import {
  removeTemporaryDirectories,
  temporaryDirectory,
} from "./authority-store-fixture.ts";
import {
  effectRequest,
  fakeDestination,
  later,
  noon,
  runningRun,
  sender,
} from "./effect-fixture.ts";
import { testMilliseconds } from "./test-timing.ts";

after(removeTemporaryDirectories);

interface Clock {
  readonly now: string;
}

interface Movable {
  now: string;
}

const wallClock: Clock = {
  get now() {
    return new Date().toISOString();
  },
};

const held = effectRequest({
  commandId: "c-1",
  round: 1,
  resource: "repository",
});

async function heldLease(scene: {
  readonly clock: Clock;
  readonly leaseMilliseconds?: number;
}): Promise<Authority> {
  const { clock, leaseMilliseconds } = scene;
  const authority = await openedAuthority(await temporaryDirectory(), {
    delivery: fakeDestination().delivery,
    clock: () => clock.now,
    timing: fastTiming,
    ...(leaseMilliseconds === undefined
      ? {}
      : { effects: { leaseMilliseconds } }),
  });
  const send = sender(authority, clock);
  await runningRun(send, { effectLimit: 5 });
  await send(held.command, held.documents);
  await deliverUntil(
    authority,
    async () =>
      (await authority.effects.operation(held.operationId))?.status ===
      "running",
  );
  return authority;
}

function scanning(
  authority: Authority,
  scan: { readonly clock: Clock; readonly intervalMilliseconds: number },
): ExpiryScan {
  const clock = (): string => scan.clock.now;
  return expiryScan({
    authority,
    gateway: commandGateway({
      authority,
      registry: workflowRegistry([]),
      clock,
      textBytes: 1000,
    }),
    clock,
    intervalMilliseconds: scan.intervalMilliseconds,
  });
}

async function leaseTimes(authority: Authority): Promise<{
  readonly endsAt: string | undefined;
  readonly expiredAt: string | undefined;
}> {
  const events = await authority.events();
  return {
    endsAt: events.find((event) => event.type === "lease.granted")?.payload[
      "expiresAt"
    ],
    expiredAt: events.find((event) => event.type === "lease.expired")
      ?.recordedAt,
  };
}

async function expiredWithin(
  authority: Authority,
  milliseconds: number,
): Promise<{ readonly endsAt: string; readonly expiredAt: string }> {
  const deadline = performance.now() + milliseconds;
  for (;;) {
    const { endsAt, expiredAt } = await leaseTimes(authority);
    assert.ok(endsAt !== undefined, "the lease has no grant");
    if (expiredAt !== undefined) return { endsAt, expiredAt };
    assert.ok(performance.now() < deadline, "the lease did not expire");
    await delay(testMilliseconds(20));
  }
}

await test("CLV-284 while nothing changes and no lease, gate or command wait is due, the expiry scan runs one lease read and then no query", async () => {
  const clock: Movable = { now: noon };
  const authority = await heldLease({ clock });
  try {
    await authority.state();
    const statements = await preparedDuring(async () => {
      const scan = scanning(authority, { clock, intervalMilliseconds: 5 });
      await delay(testMilliseconds(200));
      await scan.stop();
    });
    assert.equal(statements.length, 1, statements.join("\n"));
    assert.match(String(statements[0]), /\bFROM leases\b/);
    const scan = scanning(authority, { clock, intervalMilliseconds: 5 });
    clock.now = later;
    try {
      await expiredWithin(authority, testMilliseconds(2_000));
    } finally {
      await scan.stop();
    }
  } finally {
    await authority.close();
  }
});

await test("CLV-284 the expiry scan wakes at the end of the next lease, before the next check of its interval", async () => {
  const authority = await heldLease({
    clock: wallClock,
    leaseMilliseconds: 2_000,
  });
  const scan = scanning(authority, {
    clock: wallClock,
    intervalMilliseconds: 60_000,
  });
  try {
    const { endsAt, expiredAt } = await expiredWithin(
      authority,
      testMilliseconds(6_000),
    );
    const lateness = Date.parse(expiredAt) - Date.parse(endsAt);
    assert.ok(lateness >= 0, `${expiredAt} is before ${endsAt}`);
    assert.ok(
      lateness <= testMilliseconds(1_000),
      `${String(lateness)} ms late`,
    );
  } finally {
    await scan.stop();
    await authority.close();
  }
});

await test("CLV-284 with the service interval and the wall clock, an expired lease ends at its expiry time within one check interval", async () => {
  const authority = await heldLease({
    clock: wallClock,
    leaseMilliseconds: 1_000,
  });
  const scan = scanning(authority, {
    clock: wallClock,
    intervalMilliseconds: serviceTiming.expiryScanMilliseconds,
  });
  try {
    const { endsAt, expiredAt } = await expiredWithin(
      authority,
      testMilliseconds(6_000),
    );
    const lateness = Date.parse(expiredAt) - Date.parse(endsAt);
    assert.ok(lateness >= 0, `${expiredAt} is before ${endsAt}`);
    assert.ok(
      lateness <= testMilliseconds(serviceTiming.expiryScanMilliseconds),
      `${String(lateness)} ms late`,
    );
  } finally {
    await scan.stop();
    await authority.close();
  }
});
