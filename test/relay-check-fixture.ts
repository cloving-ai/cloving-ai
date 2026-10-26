import assert from "node:assert/strict";
import { join } from "node:path";
import { record } from "../src/protocol.ts";
import type { CheckContext } from "../src/relay/decision-check.ts";
import { checkDecisions } from "../src/relay/decision-check.ts";
import type { EnvelopeKind } from "../src/relay/envelope.ts";
import { relayControl } from "../src/relay/relay-control.ts";
import { writePrivate } from "../src/relay/relay-files.ts";
import { readLink } from "../src/relay/relay-registration.ts";
import { openRelayStore, type RelayStore } from "../src/relay/relay-store.ts";
import {
  fixtureDaemonKeys,
  fixtureDevice,
  openedEnvelope,
  type OpenedEnvelope,
} from "./phone-envelope-fixture.ts";
import {
  fakeRelayServer,
  registeredLink,
  type FakeRelayServer,
} from "./phone-relay-server-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";
import pairing from "./fixtures/phone-pairing.json" with { type: "json" };
import type { Harness } from "./service-fixture.ts";

export interface PostedItem {
  readonly deviceId: string;
  readonly kind: EnvelopeKind;
  readonly ciphertext: string;
  readonly expiresAt: string;
  readonly push: string;
  readonly collapseId: unknown;
}

const kinds: readonly EnvelopeKind[] = ["preview", "full", "closed", "receipt"];

function kindOf(value: unknown): EnvelopeKind {
  return kinds.find((kind) => kind === value) ?? "full";
}

export interface RelayUnderTest {
  readonly server: FakeRelayServer;
  readonly store: RelayStore;
  readonly context: CheckContext;
  readonly daemonId: string;
  readonly clock: { now: number };
}

function text(value: unknown, name: string): string {
  return String(record(value)?.[name]);
}

export function posted(server: FakeRelayServer): readonly PostedItem[] {
  return server.requests
    .filter((request) => request.path === "/api/v1/relay/envelopes")
    .flatMap((request) => {
      const envelopes: unknown = record(request.body)?.["envelopes"];
      return Array.isArray(envelopes) ? (envelopes as readonly unknown[]) : [];
    })
    .map((item: unknown) => ({
      deviceId: text(item, "device_id"),
      kind: kindOf(record(item)?.["kind"]),
      ciphertext: text(item, "ciphertext"),
      expiresAt: text(item, "expires_at"),
      push: text(item, "push"),
      collapseId: record(item)?.["collapse_id"],
    }));
}

export function device(
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

export function opened(item: PostedItem, daemonId: string): OpenedEnvelope {
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

export interface RelayScope {
  readonly harness: Harness;
  readonly settings?: Parameters<typeof fakeRelayServer>[0];
}

export async function relayUnderTest(
  scope: RelayScope,
  root: string,
): Promise<RelayUnderTest> {
  const { harness } = scope;
  const server = await fakeRelayServer(scope.settings);
  const phoneDirectory = join(root, "phone");
  await registeredLink(server, phoneDirectory);
  await writePrivate(
    join(phoneDirectory, "daemon-keys.json"),
    fixtureDaemonKeys,
  );
  const clock = { now: Date.now() };
  const store = await openRelayStore(phoneDirectory, { now: () => clock.now });
  return {
    server,
    store,
    clock,
    daemonId: String((await readLink(phoneDirectory))?.daemonId),
    context: {
      phoneDirectory,
      store,
      control: relayControl(harness.runtimeDirectory),
      now: () => clock.now,
    },
  };
}

export async function checked(relay: RelayUnderTest): Promise<void> {
  await checkDecisions(relay.context);
  await relay.store.delivery.drainAt(new Date(relay.clock.now));
}

export async function withRelay(
  scope: RelayScope,
  body: (relay: RelayUnderTest) => Promise<void>,
): Promise<void> {
  await withFiles({}, async (root) => {
    const relay = await relayUnderTest(scope, root);
    try {
      await body(relay);
    } finally {
      await relay.store.close();
      await relay.server.close();
    }
  });
}

export async function connected(
  store: RelayStore,
  values: { readonly deviceId: string; readonly agreementPublicKey: string },
): Promise<void> {
  await store.add(device(values.deviceId, values.agreementPublicKey));
  await store.connect(values.deviceId);
}

export async function connectedFixturePhone(store: RelayStore): Promise<void> {
  await store.add({
    ...device(fixtureDevice.deviceId, fixtureDevice.agreementPublicKey),
    answerPublicKey: pairing.device.answerPublicKey,
    approvalPublicKey: pairing.device.approvalPublicKey,
  });
  await store.connect(fixtureDevice.deviceId);
}
