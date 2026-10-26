import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { record } from "../src/protocol.ts";
import { startRelay } from "../src/relay/relay-service.ts";
import {
  fixtureDevice,
  openedEnvelope,
  verifiedBy,
} from "./phone-envelope-fixture.ts";
import { connectedPhone } from "./phone-fake-phone.ts";
import {
  fakeRelayServer,
  type FakeRelayServer,
} from "./phone-relay-server-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";
import { eventually, waitingGate, withHarness } from "./service-fixture.ts";

function sealedItems(server: FakeRelayServer): readonly unknown[] {
  return server.requests
    .filter((request) => request.path === "/api/v1/relay/envelopes")
    .flatMap((request) => {
      const envelopes: unknown = record(request.body)?.["envelopes"];
      return Array.isArray(envelopes) ? (envelopes as readonly unknown[]) : [];
    });
}

function decisionOf(server: FakeRelayServer, item: unknown): unknown {
  const daemon = server.daemons[0];
  assert.ok(daemon);
  const opened = openedEnvelope(fixtureDevice.agreementPrivateKey, {
    daemonId: daemon.daemonId,
    deviceId: fixtureDevice.deviceId,
    kind: record(item)?.["kind"] === "preview" ? "preview" : "full",
    sealed: Buffer.from(String(record(item)?.["ciphertext"]), "base64url"),
  });
  assert.ok(verifiedBy(String(daemon.signingPublicKey), opened));
  return record(opened.fields["body"])?.["decisionId"];
}

await test("CLV-191 the running relay sends an open decision when a phone connects, and a new decision when its event arrives", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const first = await waitingGate(harness, {
      service,
      commandId: "c-1",
      kind: "approval",
    });
    await withFiles({}, async (root) => {
      const server = await fakeRelayServer();
      const relay = await startRelay({
        runtimeDirectory: harness.runtimeDirectory,
        phoneDirectory: join(root, "phone"),
        origin: server.origin,
        computerName: "Studio",
        watchTiming: { pollMilliseconds: 600_000, reconnectMilliseconds: 50 },
      });
      try {
        await connectedPhone(harness.runtimeDirectory, server);
        await eventually(() =>
          sealedItems(server).length === 2 ? true : undefined,
        );
        const second = await waitingGate(harness, {
          service,
          commandId: "c-2",
          kind: "question",
        });
        await eventually(() =>
          sealedItems(server).length === 4 ? true : undefined,
        );
        assert.deepEqual(
          sealedItems(server).map((item) => decisionOf(server, item)),
          [
            first.decisionId,
            first.decisionId,
            second.decisionId,
            second.decisionId,
          ],
        );
      } finally {
        await relay.close();
        await server.close();
      }
    });
    await service.close();
  }));
