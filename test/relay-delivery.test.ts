import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { deliveryBackoffMilliseconds } from "../src/delivery-backoff.ts";
import { openRelayStore, type RelayStore } from "../src/relay/relay-store.ts";
import {
  fakeRelayServer,
  registeredLink,
  type FakeRelayServer,
} from "./phone-relay-server-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";

const decisionId = "run-1/review-1";

const offer = {
  deviceId: "phone-1",
  envelopes: [
    {
      envelopeId: "env-preview-1",
      kind: "preview",
      ciphertext: "AAAA",
      expiresAt: "2026-11-01T11:00:00.000Z",
    },
    {
      envelopeId: "env-full-1",
      kind: "full",
      ciphertext: "BBBB",
      expiresAt: "2026-11-01T11:00:00.000Z",
    },
  ],
};

interface DeliveryUnderTest {
  readonly server: FakeRelayServer;
  readonly phoneDirectory: string;
  readonly clock: { now: number };
  readonly store: RelayStore;
}

function posts(server: FakeRelayServer): readonly unknown[] {
  return server.requests
    .filter((request) => request.path === "/api/v1/relay/envelopes")
    .map((request) => request.body);
}

async function settled(
  store: RelayStore,
  clock: { now: number },
): Promise<string | undefined> {
  await store.drainAt(new Date(clock.now));
  return (await store.deliveries(decisionId))[0]?.state;
}

async function withDelivery(
  envelopeStatuses: number[],
  body: (delivery: DeliveryUnderTest) => Promise<void>,
): Promise<void> {
  await withFiles({}, async (root) => {
    const server = await fakeRelayServer({ envelopeStatuses });
    const phoneDirectory = join(root, "phone");
    await registeredLink(server, phoneDirectory);
    const clock = { now: Date.parse("2026-10-26T12:00:00.000Z") };
    const store = await openRelayStore(phoneDirectory, {
      now: () => clock.now,
    });
    try {
      await body({ server, phoneDirectory, clock, store });
    } finally {
      await store.close();
      await server.close();
    }
  });
}

await test("CLV-191 the notify command and the phone deliveries share one retry schedule", () => {
  assert.deepEqual(
    deliveryBackoffMilliseconds,
    [0, 60_000, 300_000, 900_000, 3_600_000],
  );
});

await test("CLV-191 a failed post retries after 1 and 5 minutes with the same envelopes", () =>
  withDelivery([500, 503], async ({ server, clock, store }) => {
    assert.equal(await store.offer(decisionId, offer), true);
    assert.equal(await settled(store, clock), "failed");
    clock.now += 59_999;
    assert.equal(await settled(store, clock), "failed");
    assert.equal(posts(server).length, 1);
    clock.now += 1;
    assert.equal(await settled(store, clock), "failed");
    assert.equal(posts(server).length, 2);
    clock.now += 299_999;
    assert.equal(await settled(store, clock), "failed");
    clock.now += 1;
    assert.equal(await settled(store, clock), "sent");
    assert.deepEqual(await store.deliveries(decisionId), [
      {
        deviceId: "phone-1",
        state: "sent",
        attempts: 3,
        lastAttemptAt: clock.now,
        lastFailure: null,
        envelopes: [],
      },
    ]);
    const bodies = posts(server);
    assert.equal(bodies.length, 3);
    assert.deepEqual(bodies[0], bodies[2]);
    assert.deepEqual(bodies[2], {
      envelopes: offer.envelopes.map((envelope) => ({
        device_id: "phone-1",
        envelope_id: envelope.envelopeId,
        kind: envelope.kind,
        ciphertext: envelope.ciphertext,
        expires_at: envelope.expiresAt,
        push: envelope.kind === "preview" ? "alert" : "none",
      })),
    });
  }));

await test("CLV-191 a delivered decision is not sent again after a restart", () =>
  withDelivery([], async ({ server, phoneDirectory, clock, store }) => {
    await store.offer(decisionId, offer);
    assert.equal(await settled(store, clock), "sent");
    await store.close();
    const reopened = await openRelayStore(phoneDirectory, {
      now: () => clock.now,
    });
    try {
      assert.equal(await reopened.offer(decisionId, offer), false);
      clock.now += 86_400_000;
      assert.equal(await settled(reopened, clock), "sent");
      assert.equal(posts(server).length, 1);
    } finally {
      await reopened.close();
    }
  }));

await test("CLV-191 a delivery stops after five failed attempts, and a lost registration counts as a failure", () =>
  withDelivery(
    [500, 500, 500, 500],
    async ({ server, phoneDirectory, clock, store }) => {
      await store.offer(decisionId, offer);
      await settled(store, clock);
      for (const wait of [60_000, 300_000, 900_000]) {
        clock.now += wait;
        await settled(store, clock);
      }
      await rm(join(phoneDirectory, "link.json"));
      clock.now += 3_600_000;
      assert.equal(await settled(store, clock), "failed");
      clock.now += 86_400_000;
      await settled(store, clock);
      const [delivery] = await store.deliveries(decisionId);
      assert.ok(delivery);
      assert.equal(delivery.attempts, 5);
      assert.equal(delivery.lastFailure, "relay-unregistered");
      assert.equal(posts(server).length, 4);
    },
  ));
