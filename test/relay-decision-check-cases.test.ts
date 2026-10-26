import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { Reply, ServiceRequest } from "../src/protocol.ts";
import { checkDecisions } from "../src/relay/decision-check.ts";
import {
  PhoneDelivery,
  type DeviceDelivery,
} from "../src/relay/phone-delivery.ts";
import { PhoneOutbox } from "../src/relay/phone-outbox.ts";
import { writePrivate } from "../src/relay/relay-files.ts";
import { openRelayStore, type RelayStore } from "../src/relay/relay-store.ts";
import {
  fixtureDaemonKeys,
  fixtureDevice,
  openedEnvelope,
} from "./phone-envelope-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";

const issued = Date.parse("2026-10-26T12:00:00.000Z");

function decision(
  decisionId: string,
  gate: { readonly runId: string; readonly expiresAt: string | null },
) {
  return {
    decisionId,
    label: null,
    type: "approval",
    runId: gate.runId,
    prompt: "Approve?",
    allowed: ["approve", "deny"],
    revision: 1,
    generation: 1,
    subjectDigest: `sha256:${"a".repeat(64)}`,
    expiresAt: gate.expiresAt,
  };
}

const refused: Reply = {
  kind: "error",
  error: { code: "service-unavailable", detail: "" },
};

const listed: Reply = {
  kind: "result",
  result: {
    decisions: [
      "not a decision",
      decision("run-1/a", {
        runId: "run-1",
        expiresAt: "2026-10-26T13:00:00.000Z",
      }),
      decision("run-1/b", { runId: "run-1", expiresAt: null }),
      decision("run-2/c", { runId: "run-2", expiresAt: null }),
    ],
  },
};

function fakeControl(
  requests: ServiceRequest[],
): (request: ServiceRequest) => Promise<Reply> {
  return (request) => {
    requests.push(request);
    if (request.operation === "questions")
      return Promise.resolve(requests.length === 1 ? refused : listed);
    const workflowId =
      request.parameters["runId"] === "run-1" ? "develop" : undefined;
    return Promise.resolve({ kind: "result", result: { run: { workflowId } } });
  };
}

async function withCaseStore(
  body: (scope: {
    readonly phoneDirectory: string;
    readonly store: RelayStore;
  }) => Promise<void>,
): Promise<void> {
  await withFiles({}, async (root) => {
    const phoneDirectory = join(root, "phone");
    await mkdir(phoneDirectory);
    await writePrivate(join(phoneDirectory, "link.json"), {
      daemonId: "dmn_1",
      origin: "http://127.0.0.1:9",
      token: "t",
      registeredAt: "2026-10-25T12:00:00Z",
    });
    await writePrivate(
      join(phoneDirectory, "daemon-keys.json"),
      fixtureDaemonKeys,
    );
    const store = await openRelayStore(phoneDirectory);
    try {
      await store.add({
        ...fixtureDevice,
        name: "Phone",
        platform: "ios",
        answerPublicKey: fixtureDevice.agreementPublicKey,
        approvalPublicKey: fixtureDevice.agreementPublicKey,
        pairedAt: "2026-10-25T12:00:00.000Z",
        state: "connected",
        removedAt: null,
      });
      await body({ phoneDirectory, store });
    } finally {
      await store.close();
    }
  });
}

await test("CLV-191 a check skips a refused reply, malformed rows and a run without a workflow, reads each run once and keeps the gate expiry", async () => {
  await withCaseStore(async ({ phoneDirectory, store }) => {
    const requests: ServiceRequest[] = [];
    const context = {
      phoneDirectory,
      store,
      control: fakeControl(requests),
      now: () => issued,
    };
    await checkDecisions(context);
    await checkDecisions(context);
    const expiry = async (decisionId: string) =>
      (await store.delivery.list(decisionId))[0]?.envelopes.map(
        (envelope) => envelope.expiresAt,
      );
    assert.deepEqual(await expiry("run-1/a"), [
      "2026-10-26T13:00:00.000Z",
      "2026-10-26T13:00:00.000Z",
    ]);
    assert.deepEqual(await expiry("run-1/b"), [
      "2026-11-02T11:00:00.000Z",
      "2026-11-02T11:00:00.000Z",
    ]);
    assert.deepEqual(await store.delivery.list("run-2/c"), []);
    assert.deepEqual(
      requests.map((request) => request.parameters["runId"] ?? null),
      [null, null, "run-1", "run-2"],
    );
  });
});

await test("CLV-192 a decision of a run that the service no longer knows closes with the outcome unknown", async () => {
  await withCaseStore(async ({ phoneDirectory, store }) => {
    await store.delivery.offer("run-gone/a", {
      runId: "run-gone",
      deviceId: fixtureDevice.deviceId,
      envelopes: [],
    });
    await checkDecisions({
      phoneDirectory,
      store,
      control: (request) =>
        Promise.resolve(
          request.operation === "questions"
            ? { kind: "result", result: { decisions: [] } }
            : {
                kind: "error",
                error: { code: "unknown-run", detail: "" },
              },
        ),
      now: () => issued,
    });
    assert.deepEqual(await store.delivery.open(), []);
    const closed = (await store.delivery.list("run-gone/a")).find(
      (item) => item.topic === "closed",
    );
    const ciphertext = closed?.envelopes[0]?.ciphertext ?? "";
    const body = openedEnvelope(fixtureDevice.agreementPrivateKey, {
      daemonId: "dmn_1",
      deviceId: fixtureDevice.deviceId,
      kind: "closed",
      sealed: Buffer.from(ciphertext, "base64url"),
    }).fields["body"];
    assert.deepEqual(body, {
      decisionId: "run-gone/a",
      outcome: "unknown",
      actor: null,
    });
  });
});

await test("CLV-191 a repeated post callback and a stale retry reminder do not change a delivery", () => {
  const actor = new PhoneDelivery("run-1/review-1");
  const sent: DeviceDelivery = {
    deviceId: "phone-1",
    topic: "decision",
    state: "sent",
    attempts: 1,
    lastAttemptAt: issued,
    lastFailure: null,
    envelopes: [],
  };
  const spent: DeviceDelivery = {
    ...sent,
    deviceId: "phone-2",
    state: "failed",
    attempts: 5,
    lastFailure: "relay-status-500",
  };
  actor.deliveries = [sent, spent];
  actor.posted({
    effectId: "effect-1",
    arguments: { deviceId: "phone-1", topic: "decision" },
    result: { at: issued + 1, failure: null },
  });
  actor.retry({ deviceId: "phone-2", topic: "decision" });
  actor.retry({ deviceId: "phone-9", topic: "decision" });
  assert.deepEqual(actor.deliveries, [sent, spent]);
});

await test("CLV-192 the outbox keeps one entry for each open decision and each retired decision", () => {
  const outbox = new PhoneOutbox("phone");
  assert.equal(outbox.track({ decisionId: "run-1/a", runId: "run-1" }), true);
  assert.equal(outbox.track({ decisionId: "run-1/a", runId: "run-1" }), false);
  outbox.retire({ decisionId: "run-1/a" });
  outbox.retire({ decisionId: "run-1/a" });
  assert.deepEqual(outbox.retired, ["run-1/a"]);
  assert.equal(outbox.untrack({ decisionId: "run-1/a" }), true);
  assert.equal(outbox.untrack({ decisionId: "run-1/a" }), false);
  outbox.forget({ decisionId: "run-1/a" });
  assert.deepEqual([outbox.decisions, outbox.retired], [[], []]);
});
