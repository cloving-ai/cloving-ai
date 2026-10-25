import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { newDaemonKeys } from "../src/relay/daemon-keys.ts";
import {
  fixtureDaemonKeys,
  fixtureDevice,
  verifiedBy,
  type OpenedEnvelope,
} from "./phone-envelope-fixture.ts";
import {
  checked,
  connected,
  device,
  opened,
  posted,
  withRelay,
} from "./relay-check-fixture.ts";
import { digestOf, waitingGate, withHarness } from "./service-fixture.ts";

function assertBodies(
  envelopes: readonly OpenedEnvelope[],
  waiting: { readonly runId: string; readonly decisionId: string },
): void {
  const prompt = "approval of c-1?";
  const shared = {
    decisionId: waiting.decisionId,
    label: null,
    type: "approval",
    workflowId: "develop",
    expiresAt: null,
    prompt,
    truncated: false,
  };
  assert.deepEqual(
    envelopes.map((envelope) => envelope.fields["body"]),
    [
      shared,
      {
        ...shared,
        runId: waiting.runId,
        allowed: ["approve", "deny"],
        revision: 1,
        generation: 1,
        subjectDigest: digestOf(prompt),
        promptDigest: `sha256:${createHash("sha256").update(prompt).digest("hex")}`,
      },
    ],
  );
}

await test("CLV-191 a pending decision sends a preview and a full envelope to each connected device, and none to a removed or checking device", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const waiting = await waitingGate(harness, {
      service,
      commandId: "c-1",
      kind: "approval",
    });
    await withRelay({ harness }, async (relay) => {
      const { store } = relay;
      const other = newDaemonKeys().agreementPublicKey;
      await connected(store, fixtureDevice);
      await connected(store, {
        deviceId: "removed",
        agreementPublicKey: other,
      });
      await store.remove("removed");
      await store.add(device("checking", other));
      await checked(relay);
      const items = posted(relay.server);
      assert.deepEqual(
        items.map((item) => [item.deviceId, item.kind, item.push]),
        [
          [fixtureDevice.deviceId, "preview", "alert"],
          [fixtureDevice.deviceId, "full", "none"],
        ],
      );
      const envelopes = items.map((item) => opened(item, relay.daemonId));
      assertBodies(envelopes, waiting);
      for (const [index, envelope] of envelopes.entries()) {
        assert.equal(envelope.fields["sequence"], index + 1);
        assert.equal(envelope.fields["daemonId"], relay.daemonId);
        assert.equal(envelope.fields["expiresAt"], items[index]?.expiresAt);
        assert.ok(verifiedBy(fixtureDaemonKeys.signingPublicKey, envelope));
      }
      await checked(relay);
      assert.equal(posted(relay.server).length, 2);
    });
    await service.close();
  }));

await test("CLV-191 a device connected after the decision opened gets it, and the sequence of a device only goes up", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    await waitingGate(harness, { service, commandId: "c-1", kind: "question" });
    await withRelay({ harness }, async (relay) => {
      await checked(relay);
      assert.equal(posted(relay.server).length, 0);
      await connected(relay.store, fixtureDevice);
      await checked(relay);
      await waitingGate(harness, {
        service,
        commandId: "c-2",
        kind: "approval",
      });
      await checked(relay);
      assert.deepEqual(
        posted(relay.server).map(
          (item) => opened(item, relay.daemonId).fields["sequence"],
        ),
        [1, 2, 3, 4],
      );
    });
    await service.close();
  }));
