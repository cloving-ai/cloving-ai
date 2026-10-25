import assert from "node:assert/strict";
import { test } from "node:test";
import type { Reply } from "../src/protocol.ts";
import { newDaemonKeys } from "../src/relay/daemon-keys.ts";
import { checkDecisions } from "../src/relay/decision-check.ts";
import { openRelayStore } from "../src/relay/relay-store.ts";
import { fixtureDevice, verifiedBy } from "./phone-envelope-fixture.ts";
import { fixtureDaemonKeys } from "./phone-envelope-fixture.ts";
import {
  checked,
  connected,
  opened,
  posted,
  withRelay,
  type RelayUnderTest,
} from "./relay-check-fixture.ts";
import {
  call,
  decide,
  digestOf,
  eventually,
  field,
  items,
  later,
  noon,
  waitingGate,
  withHarness,
} from "./service-fixture.ts";

const prompt = "approval of c-1?";

function closedItems(relay: RelayUnderTest) {
  return posted(relay.server).filter((item) => item.kind === "closed");
}

function closedBody(relay: RelayUnderTest): unknown {
  const [item] = closedItems(relay).filter(
    (closed) => closed.deviceId === fixtureDevice.deviceId,
  );
  assert.ok(item);
  const envelope = opened(item, relay.daemonId);
  assert.ok(verifiedBy(fixtureDaemonKeys.signingPublicKey, envelope));
  return envelope.fields["body"];
}

await test("CLV-192 a terminal approval after a sent decision sends one passive closed envelope to each device, with an opaque collapse ID", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const waiting = await waitingGate(harness, {
      service,
      commandId: "c-1",
      kind: "approval",
    });
    await withRelay({ harness }, async (relay) => {
      await connected(relay.store, fixtureDevice);
      await connected(relay.store, {
        deviceId: "phone-2",
        agreementPublicKey: newDaemonKeys().agreementPublicKey,
      });
      await checked(relay);
      assert.equal(posted(relay.server).length, 4);
      await decide(harness, {
        command: "approve",
        reference: waiting.decisionId,
        subjectDigest: digestOf(prompt),
      });
      await checked(relay);
      const closed = closedItems(relay);
      assert.deepEqual(
        closed.map((item) => [item.deviceId, item.push]).sort(),
        [
          [fixtureDevice.deviceId, "passive"],
          ["phone-2", "passive"],
        ],
      );
      const collapseIds = new Set(
        posted(relay.server)
          .filter((item) => item.kind !== "full")
          .map((item) => item.collapseId),
      );
      assert.equal(collapseIds.size, 1);
      const [collapseId] = [...collapseIds];
      assert.match(String(collapseId), /^[A-Za-z0-9_-]{22}$/);
      assert.ok(!String(collapseId).includes(waiting.runId.slice(4, 12)));
      assert.deepEqual(closedBody(relay), {
        decisionId: waiting.decisionId,
        outcome: "approved",
        actor: "local",
      });
      await checked(relay);
      assert.equal(posted(relay.server).length, 6);
    });
    await service.close();
  }));

await test("CLV-192 an expired decision closes with the outcome expired", () =>
  withHarness(async (harness) => {
    let now = noon;
    const service = await harness.start({ clock: () => now });
    const waiting = await waitingGate(harness, {
      service,
      commandId: "c-1",
      kind: "approval",
      expiresAt: later,
    });
    await withRelay({ harness }, async (relay) => {
      await connected(relay.store, fixtureDevice);
      await checked(relay);
      now = later;
      await decide(harness, {
        command: "approve",
        reference: waiting.decisionId,
        subjectDigest: digestOf(prompt),
      });
      await eventually(async () => {
        const listed = await call(harness, {
          operation: "questions",
          parameters: {},
        });
        return items(field(listed, "decisions")).length === 0
          ? true
          : undefined;
      });
      await checked(relay);
      assert.deepEqual(closedBody(relay), {
        decisionId: waiting.decisionId,
        outcome: "expired",
        actor: "local",
      });
    });
    await service.close();
  }));

await test("CLV-192 a decision that closed before any envelope was sent gets no closed envelope, and its retries stop", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const waiting = await waitingGate(harness, {
      service,
      commandId: "c-1",
      kind: "approval",
    });
    await withRelay(
      { harness, settings: { envelopeStatuses: [500] } },
      async (relay) => {
        await connected(relay.store, fixtureDevice);
        await checked(relay);
        await decide(harness, {
          command: "approve",
          reference: waiting.decisionId,
          subjectDigest: digestOf(prompt),
        });
        await checked(relay);
        relay.clock.now += 86_400_000;
        await checked(relay);
        assert.equal(posted(relay.server).length, 2);
        assert.deepEqual(closedItems(relay), []);
      },
    );
    await service.close();
  }));

await test("CLV-192 seven days after the closed envelope the delivery of the decision is gone, and a restart sends nothing again", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const waiting = await waitingGate(harness, {
      service,
      commandId: "c-1",
      kind: "approval",
    });
    await withRelay({ harness }, async (relay) => {
      await connected(relay.store, fixtureDevice);
      await checked(relay);
      await decide(harness, {
        command: "approve",
        reference: waiting.decisionId,
        subjectDigest: digestOf(prompt),
      });
      await checked(relay);
      relay.clock.now += 7 * 86_400_000 - 1000;
      await checked(relay);
      await checked(relay);
      assert.notDeepEqual(
        await relay.store.delivery.list(waiting.decisionId),
        [],
      );
      relay.clock.now += 1000;
      await checked(relay);
      await checked(relay);
      assert.deepEqual(await relay.store.delivery.list(waiting.decisionId), []);
      assert.deepEqual(await relay.store.delivery.open(), []);
      await relay.store.close();
      const reopened = await openRelayStore(relay.context.phoneDirectory, {
        now: () => relay.clock.now,
      });
      try {
        await checkDecisions({ ...relay.context, store: reopened });
        await reopened.delivery.drainAt(new Date(relay.clock.now));
        assert.equal(posted(relay.server).length, 3);
      } finally {
        await reopened.close();
      }
    });
    await service.close();
  }));

await test("CLV-192 a failed status request keeps the decision open, and the next check closes it with the real outcome", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const waiting = await waitingGate(harness, {
      service,
      commandId: "c-1",
      kind: "approval",
    });
    await withRelay({ harness }, async (relay) => {
      await connected(relay.store, fixtureDevice);
      await checked(relay);
      await decide(harness, {
        command: "approve",
        reference: waiting.decisionId,
        subjectDigest: digestOf(prompt),
      });
      const operations: string[] = [];
      const unavailable: Reply = {
        kind: "error",
        error: { code: "service-unavailable", detail: "" },
      };
      await checkDecisions({
        ...relay.context,
        control: (request) => {
          operations.push(request.operation);
          return request.operation === "status"
            ? Promise.resolve(unavailable)
            : relay.context.control(request);
        },
      });
      assert.deepEqual(operations, ["questions", "status"]);
      assert.deepEqual(
        (await relay.store.delivery.open()).map((item) => item.decisionId),
        [waiting.decisionId],
      );
      await checked(relay);
      assert.deepEqual(closedBody(relay), {
        decisionId: waiting.decisionId,
        outcome: "approved",
        actor: "local",
      });
    });
    await service.close();
  }));
