import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { phoneRequest } from "../src/cli/phone-client.ts";
import { pairingCode } from "../src/relay/pairing-checks.ts";
import { startRelay, type Relay } from "../src/relay/relay-service.ts";
import { canonicalJson } from "../src/phone/canonical-json.ts";
import { record } from "../src/protocol.ts";
import fixture from "./fixtures/phone-pairing.json" with { type: "json" };
import {
  receiptFields,
  sendPhoneCheck,
  sendPhoneRequest,
  type PhoneRequestValues,
} from "./phone-fake-phone.ts";
import {
  fakeRelayServer,
  type FakeRelayServer,
} from "./phone-relay-server-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";

type Fields = Readonly<Record<string, unknown>>;

interface Setup {
  readonly root: string;
  readonly runtimeDirectory: string;
  readonly server: FakeRelayServer;
  relay: Relay;
}

async function call(
  setup: Setup,
  request: { readonly operation: string; readonly parameters?: Fields },
): Promise<Fields> {
  const reply = await phoneRequest(setup.runtimeDirectory, {
    operation: request.operation,
    parameters: request.parameters ?? {},
  });
  assert.equal(reply?.kind, "result", JSON.stringify(reply));
  return reply.result;
}

async function until(
  setup: Setup,
  check: (state: Fields) => boolean,
): Promise<Fields> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const state = await call(setup, { operation: "phone-state" });
    if (check(state)) return state;
    await new Promise((settle) => setTimeout(settle, 20));
  }
  assert.fail(JSON.stringify(await call(setup, { operation: "phone-state" })));
}

function relayStart(setup: Omit<Setup, "relay">): Promise<Relay> {
  return startRelay({
    runtimeDirectory: setup.runtimeDirectory,
    phoneDirectory: join(setup.root, "state/phone"),
    origin: setup.server.origin,
    computerName: "Studio",
  });
}

async function withRelay(
  body: (setup: Setup) => Promise<void>,
  settings: Parameters<typeof fakeRelayServer>[0] = {},
): Promise<void> {
  await withFiles({}, async (root) => {
    const server = await fakeRelayServer(settings);
    const base = { root, runtimeDirectory: join(root, "run"), server };
    const setup: Setup = { ...base, relay: await relayStart(base) };
    try {
      await body(setup);
    } finally {
      await setup.relay.close();
      await server.close();
    }
  });
}

async function requested(
  setup: Setup,
  values: PhoneRequestValues = {},
): Promise<{ readonly pairingId: string; readonly state: Fields }> {
  const started = await call(setup, { operation: "phone-pair-start" });
  const pairingId = sendPhoneRequest(setup.server, {
    link: String(started["link"]),
    values,
  });
  const state = await until(
    setup,
    (current) =>
      Reflect.get(Object(current["pairing"]), "stage") === "requested" ||
      current["refusal"] !== null,
  );
  return { pairingId, state };
}

function device(state: Fields, deviceId: string): Fields | undefined {
  const devices = state["devices"];
  assert.ok(Array.isArray(devices));
  return devices
    .map((item: unknown) => record(item))
    .find((item) => item?.["deviceId"] === deviceId);
}

function receiptSigned(
  server: FakeRelayServer,
  signed: { readonly payload: string; readonly receipt: unknown },
): boolean {
  const point = Buffer.from(
    String(server.daemons[0]?.signingPublicKey),
    "base64url",
  );
  const key = createPublicKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: point.subarray(1, 33).toString("base64url"),
      y: point.subarray(33).toString("base64url"),
    },
    format: "jwk",
  });
  return verify(
    "sha256",
    Buffer.from(signed.payload),
    { key, dsaEncoding: "ieee-p1363" },
    Buffer.from(
      String(Reflect.get(Object(signed.receipt), "signature")),
      "base64url",
    ),
  );
}

await test("CLV-189 the request shows the code, and Accept records a checking device with a signed receipt that survives a restart", async () => {
  await withRelay(async (setup) => {
    const { pairingId, state } = await requested(setup);
    const shown = record(record(state["pairing"])?.["request"]);
    assert.match(String(shown?.["code"]), /^\d{6}$/);
    assert.deepEqual(shown, {
      deviceId: fixture.device.id,
      name: "Pixel 8a",
      platform: "android",
      code: shown?.["code"],
    });
    await call(setup, {
      operation: "phone-pair-accept",
      parameters: { pairingId },
    });
    const accepted = await call(setup, { operation: "phone-state" });
    assert.equal(device(accepted, fixture.device.id)?.["state"], "checking");
    const receipt = setup.server.pairings.get(pairingId)?.receipt;
    const payload = String(Reflect.get(Object(receipt), "payload"));
    const fields = receiptFields(setup.server, pairingId);
    assert.equal(canonicalJson(fields), payload);
    assert.deepEqual(Object.keys(fields), [
      "daemonId",
      "deviceId",
      "kind",
      "nonce",
      "pairedAt",
      "version",
    ]);
    assert.equal(fields["daemonId"], "dmn_test1");
    assert.equal(fields["kind"], "pairing-receipt");
    assert.ok(receiptSigned(setup.server, { payload, receipt }));
    await setup.relay.close();
    setup.relay = await relayStart(setup);
    const restarted = await call(setup, { operation: "phone-state" });
    assert.equal(device(restarted, fixture.device.id)?.["state"], "checking");
  });
});

await test("CLV-189 a correct check connects the device", async () => {
  await withRelay(async (setup) => {
    const { pairingId } = await requested(setup);
    await call(setup, {
      operation: "phone-pair-accept",
      parameters: { pairingId },
    });
    sendPhoneCheck(setup.server, { pairingId });
    const state = await until(
      setup,
      (current) =>
        device(current, fixture.device.id)?.["state"] === "connected" &&
        current["pairing"] === null,
    );
    assert.equal(state["refusal"], null);
  });
});

for (const [label, exchange] of [
  ["a wrong signature", { signer: "wrong" }],
  ["a wrong nonce", { nonce: "AAAAAAAAAAAAAAAAAAAAAA" }],
] as const)
  await test(`CLV-189 a check with ${label} keeps the device checking`, async () => {
    await withRelay(async (setup) => {
      const { pairingId } = await requested(setup);
      await call(setup, {
        operation: "phone-pair-accept",
        parameters: { pairingId },
      });
      sendPhoneCheck(setup.server, { pairingId, ...exchange });
      const state = await until(
        setup,
        (current) => current["pairing"] === null,
      );
      assert.equal(device(state, fixture.device.id)?.["state"], "checking");
      assert.equal(state["refusal"], "pairing-check-invalid");
    });
  });

await test("CLV-189 the 6-digit code of the fixture secret and request", () => {
  assert.equal(
    pairingCode(
      Buffer.from(fixture.secret, "base64url"),
      fixture.requestCanonical,
    ),
    fixture.code,
  );
});

for (const [label, values, code] of [
  ["a wrong HMAC", { mac: "A".repeat(43) }, "pairing-mac-invalid"],
  [
    "a bad key",
    { answerPublicKey: `B${"A".repeat(86)}` },
    "pairing-key-invalid",
  ],
  ["a bad device ID", { deviceId: "bad id" }, "pairing-request-invalid"],
] as const)
  await test(`CLV-189 a request with ${label} is refused with ${code} and gives no device`, async () => {
    await withRelay(async (setup) => {
      const { pairingId, state } = await requested(setup, values);
      assert.equal(state["refusal"], code);
      assert.deepEqual(state["devices"], []);
      await until(setup, (current) => current["pairing"] === null);
      assert.equal(setup.server.pairings.get(pairingId)?.stage, "denied");
    });
  });

await test("CLV-189 an expired pairing is refused with pairing-expired and gives no device", async () => {
  await withRelay(async (setup) => {
    const { pairingId } = await requested(setup);
    setup.server.change(pairingId, { stage: "expired" });
    const state = await until(setup, (current) => current["pairing"] === null);
    assert.equal(state["refusal"], "pairing-expired");
    assert.deepEqual(state["devices"], []);
  });
});

await test("CLV-189 Deny gives no device and no receipt, and tells cloving.ai", async () => {
  await withRelay(async (setup) => {
    const { pairingId } = await requested(setup);
    await call(setup, {
      operation: "phone-pair-deny",
      parameters: { pairingId },
    });
    const state = await call(setup, { operation: "phone-state" });
    assert.deepEqual(state["devices"], []);
    assert.equal(state["pairing"], null);
    assert.equal(setup.server.pairings.get(pairingId)?.receipt, null);
    assert.ok(
      setup.server.requests.some(
        (request) =>
          request.method === "POST" &&
          request.path === `/api/v1/relay/pairings/${pairingId}/deny`,
      ),
    );
  });
});

await test("CLV-189 phone-remove writes a tombstone, tells cloving.ai, and a new pairing of the same device is refused", async () => {
  await withRelay(async (setup) => {
    const { pairingId } = await requested(setup);
    await call(setup, {
      operation: "phone-pair-accept",
      parameters: { pairingId },
    });
    sendPhoneCheck(setup.server, { pairingId });
    await until(
      setup,
      (current) =>
        device(current, fixture.device.id)?.["state"] === "connected",
    );
    const removed = await call(setup, {
      operation: "phone-remove",
      parameters: { deviceId: fixture.device.id },
    });
    assert.equal(removed["warning"], null);
    const state = await call(setup, { operation: "phone-state" });
    assert.match(
      String(device(state, fixture.device.id)?.["removedAt"]),
      /^\d{4}-/,
    );
    assert.ok(
      setup.server.requests.some(
        (request) =>
          request.method === "DELETE" &&
          request.path === `/api/v1/relay/devices/${fixture.device.id}`,
      ),
    );
    const again = await requested(setup);
    assert.equal(again.state["refusal"], "pairing-device-revoked");
  });
});

await test("CLV-189 a double Accept sends one receipt, and the check still connects the phone", async () => {
  await withRelay(async (setup) => {
    const { pairingId } = await requested(setup);
    const accept = {
      operation: "phone-pair-accept",
      parameters: { pairingId },
    };
    const [first, second] = await Promise.all([
      call(setup, accept),
      call(setup, accept),
    ]);
    assert.deepEqual(first, second);
    assert.equal(
      setup.server.requests.filter((item) => item.path.endsWith("/receipt"))
        .length,
      1,
    );
    sendPhoneCheck(setup.server, { pairingId });
    await until(
      setup,
      (current) =>
        device(current, fixture.device.id)?.["state"] === "connected" &&
        current["pairing"] === null,
    );
  });
});

await test("CLV-189 a reset during the registration leaves no registration and no pairing", async () => {
  await withRelay(
    async (setup) => {
      const starting = phoneRequest(setup.runtimeDirectory, {
        operation: "phone-pair-start",
        parameters: {},
      });
      await new Promise((settle) => setTimeout(settle, 100));
      await call(setup, { operation: "phone-reset" });
      const started = await starting;
      assert.equal(
        started?.kind === "error" ? started.error.code : "",
        "phone-relay-failed",
      );
      const state = await call(setup, { operation: "phone-state" });
      assert.deepEqual([state["registered"], state["pairing"]], [false, null]);
      for (const file of ["link.json", "daemon-keys.json"])
        await assert.rejects(stat(join(setup.root, "state/phone", file)), {
          code: "ENOENT",
        });
    },
    { registerDelayMilliseconds: 400 },
  );
});

await test("CLV-189 a new registration after cloving.ai ended the old one removes the phones of the old one", async () => {
  await withRelay(async (setup) => {
    const { pairingId } = await requested(setup);
    await call(setup, {
      operation: "phone-pair-accept",
      parameters: { pairingId },
    });
    sendPhoneCheck(setup.server, { pairingId });
    await until(setup, (current) => current["pairing"] === null);
    setup.server.revoke("token-1");
    await call(setup, { operation: "phone-pair-start" });
    const state = await call(setup, { operation: "phone-state" });
    assert.equal(state["daemonId"], "dmn_test2");
    assert.notEqual(device(state, fixture.device.id)?.["removedAt"], null);
  });
});
