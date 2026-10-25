import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import { record } from "../src/protocol.ts";
import { newDaemonKeys } from "../src/relay/daemon-keys.ts";
import {
  checkDecisions,
  type CheckContext,
} from "../src/relay/decision-check.ts";
import { relayControl } from "../src/relay/relay-control.ts";
import { writePrivate } from "../src/relay/relay-files.ts";
import { readLink } from "../src/relay/relay-registration.ts";
import { openRelayStore, type RelayStore } from "../src/relay/relay-store.ts";
import {
  fixtureDaemonKeys,
  fixtureDevice,
  openedEnvelope,
  verifiedBy,
  type OpenedEnvelope,
} from "./phone-envelope-fixture.ts";
import {
  fakeRelayServer,
  registeredLink,
  type FakeRelayServer,
} from "./phone-relay-server-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";
import {
  digestOf,
  waitingGate,
  withHarness,
  type Harness,
} from "./service-fixture.ts";

interface PostedItem {
  readonly deviceId: string;
  readonly kind: "preview" | "full";
  readonly ciphertext: string;
  readonly expiresAt: string;
  readonly push: string;
}

interface RelayUnderTest {
  readonly server: FakeRelayServer;
  readonly store: RelayStore;
  readonly context: CheckContext;
  readonly daemonId: string;
}

function text(value: unknown, name: string): string {
  return String(record(value)?.[name]);
}

function posted(server: FakeRelayServer): readonly PostedItem[] {
  return server.requests
    .filter((request) => request.path === "/api/v1/relay/envelopes")
    .flatMap((request) => {
      const envelopes: unknown = record(request.body)?.["envelopes"];
      return Array.isArray(envelopes) ? (envelopes as readonly unknown[]) : [];
    })
    .map((item: unknown) => ({
      deviceId: text(item, "device_id"),
      kind: text(item, "kind") === "preview" ? "preview" : "full",
      ciphertext: text(item, "ciphertext"),
      expiresAt: text(item, "expires_at"),
      push: text(item, "push"),
    }));
}

function device(
  deviceId: string,
  agreementPublicKey: string,
): Parameters<RelayStore["add"]>[0] {
  return {
    deviceId,
    name: deviceId,
    platform: "ios",
    agreementPublicKey,
    answerPublicKey: agreementPublicKey,
    approvalPublicKey: agreementPublicKey,
    pairedAt: "2026-10-25T12:00:00.000Z",
    state: "checking",
    removedAt: null,
  };
}

function opened(item: PostedItem, daemonId: string): OpenedEnvelope {
  const sealed = Buffer.from(item.ciphertext, "base64url");
  assert.ok(
    [1024, 4096, 16_384, 65_536].includes(sealed.length - 65 - 16),
    String(sealed.length),
  );
  return openedEnvelope(fixtureDevice.agreementPrivateKey, {
    daemonId,
    deviceId: item.deviceId,
    kind: item.kind,
    sealed,
  });
}

async function relayUnderTest(
  harness: Harness,
  root: string,
): Promise<RelayUnderTest> {
  const server = await fakeRelayServer();
  const phoneDirectory = join(root, "phone");
  await registeredLink(server, phoneDirectory);
  await writePrivate(
    join(phoneDirectory, "daemon-keys.json"),
    fixtureDaemonKeys,
  );
  const store = await openRelayStore(phoneDirectory);
  return {
    server,
    store,
    daemonId: String((await readLink(phoneDirectory))?.daemonId),
    context: {
      phoneDirectory,
      store,
      control: relayControl(harness.runtimeDirectory),
      now: () => Date.now(),
    },
  };
}

async function checked(relay: RelayUnderTest): Promise<void> {
  await checkDecisions(relay.context);
  await relay.store.delivery.drainAt(new Date());
}

async function withRelay(
  harness: Harness,
  body: (relay: RelayUnderTest) => Promise<void>,
): Promise<void> {
  await withFiles({}, async (root) => {
    const relay = await relayUnderTest(harness, root);
    try {
      await body(relay);
    } finally {
      await relay.store.close();
      await relay.server.close();
    }
  });
}

async function connected(
  store: RelayStore,
  values: { readonly deviceId: string; readonly agreementPublicKey: string },
): Promise<void> {
  await store.add(device(values.deviceId, values.agreementPublicKey));
  await store.connect(values.deviceId);
}

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
    await withRelay(harness, async (relay) => {
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
    await withRelay(harness, async (relay) => {
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
