import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { phoneRequest } from "../src/cli/phone-client.ts";
import { record, type Fields } from "../src/protocol.ts";
import { checkedRequest, checkValid } from "../src/relay/pairing-checks.ts";
import { newDaemonKeys } from "../src/relay/daemon-keys.ts";
import { pairingSessions } from "../src/relay/pairing-session.ts";
import { relayRequest } from "../src/relay/relay-http.ts";
import { startRelay, type Relay } from "../src/relay/relay-service.ts";
import { openRelayStore } from "../src/relay/relay-store.ts";
import fixture from "./fixtures/phone-pairing.json" with { type: "json" };
import {
  phoneRequestBody,
  sendPhoneCheck,
  sendPhoneRequest,
} from "./phone-fake-phone.ts";
import {
  fakeRelayServer,
  type FakeRelayServer,
} from "./phone-relay-server-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";

interface Setup {
  readonly runtimeDirectory: string;
  readonly server: FakeRelayServer;
  readonly relay: Relay;
}

async function withRelay(
  settings: {
    readonly pairingMilliseconds?: number;
    readonly receiptStatus?: number;
  },
  body: (setup: Setup) => Promise<void>,
): Promise<void> {
  await withFiles({}, async (root) => {
    const server = await fakeRelayServer(settings);
    const runtimeDirectory = join(root, "run");
    const relay = await startRelay({
      runtimeDirectory,
      phoneDirectory: join(root, "state/phone"),
      origin: server.origin,
      computerName: "Studio",
    });
    try {
      await body({ runtimeDirectory, server, relay });
    } finally {
      await relay.close();
      await server.close();
    }
  });
}

async function call(
  setup: Setup,
  request: { readonly operation: string; readonly parameters?: Fields },
) {
  return phoneRequest(setup.runtimeDirectory, {
    operation: request.operation,
    parameters: request.parameters ?? {},
  });
}

async function state(setup: Setup): Promise<Fields> {
  const reply = await call(setup, { operation: "phone-state" });
  assert.equal(reply?.kind, "result", JSON.stringify(reply));
  return reply.result;
}

async function until(
  setup: Setup,
  check: (current: Fields) => boolean,
): Promise<Fields> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const current = await state(setup);
    if (check(current)) return current;
    await new Promise((settle) => setTimeout(settle, 20));
  }
  assert.fail(JSON.stringify(await state(setup)));
}

function stage(current: Fields): unknown {
  return record(current["pairing"])?.["stage"];
}

async function requested(setup: Setup): Promise<string> {
  const reply = await call(setup, { operation: "phone-pair-start" });
  assert.equal(reply?.kind, "result", JSON.stringify(reply));
  const pairingId = sendPhoneRequest(setup.server, {
    link: String(reply.result["link"]),
  });
  await until(setup, (current) => stage(current) === "requested");
  return pairingId;
}

function code(reply: Awaited<ReturnType<typeof call>>): string {
  return reply?.kind === "error" ? reply.error.code : "";
}

await test("CLV-189 accept and deny need a waiting request", async () => {
  await withRelay({}, async (setup) => {
    assert.equal(
      code(await call(setup, { operation: "phone-pair-accept" })),
      "pairing-not-requested",
    );
    assert.equal(
      code(await call(setup, { operation: "phone-pair-deny" })),
      "pairing-not-requested",
    );
    assert.equal(
      code(
        await call(setup, {
          operation: "phone-remove",
          parameters: { deviceId: 7 },
        }),
      ),
      "phone-unknown",
    );
  });
});

await test("CLV-189 a refused receipt keeps the request and reports the cause", async () => {
  await withRelay({ receiptStatus: 500 }, async (setup) => {
    await requested(setup);
    assert.equal(
      code(await call(setup, { operation: "phone-pair-accept" })),
      "receipt-failed",
    );
  });
});

await test("CLV-189 the pairing ends with pairing-expired at the local expiry when the request waits", async () => {
  await withRelay({ pairingMilliseconds: 600 }, async (setup) => {
    await requested(setup);
    const ended = await until(setup, (current) => current["pairing"] === null);
    assert.equal(ended["refusal"], "pairing-expired");
  });
});

await test("CLV-189 a pairing that cloving.ai no longer knows ends", async () => {
  await withRelay({}, async (setup) => {
    const pairingId = await requested(setup);
    setup.server.pairings.delete(pairingId);
    setup.server.change(pairingId, {});
    const ended = await until(setup, (current) => current["pairing"] === null);
    assert.equal(ended["refusal"], "pairing-expired");
  });
});

await test("CLV-189 a phone removed between the request and Accept is refused", async () => {
  await withRelay({}, async (setup) => {
    const first = await requested(setup);
    await call(setup, { operation: "phone-pair-accept" });
    sendPhoneCheck(setup.server, { pairingId: first });
    await until(setup, (current) => current["pairing"] === null);
    await requested(setup);
    await call(setup, {
      operation: "phone-remove",
      parameters: { deviceId: fixture.device.id },
    });
    assert.equal(
      code(await call(setup, { operation: "phone-pair-accept" })),
      "pairing-device-revoked",
    );
    assert.equal((await state(setup))["refusal"], "pairing-device-revoked");
  });
});

await test("CLV-189 the store refuses a removed device and counts a reset", async () => {
  await withFiles({}, async (root) => {
    const store = await openRelayStore(root);
    try {
      const device = {
        deviceId: "phone-1",
        name: "Pixel",
        platform: "android",
        agreementPublicKey: "a",
        answerPublicKey: "b",
        approvalPublicKey: "c",
        pairedAt: "2026-10-25T12:00:00Z",
        state: "checking" as const,
        removedAt: null,
      };
      assert.equal(await store.add(device), undefined);
      assert.equal(await store.connect("nobody"), false);
      assert.equal(await store.remove("phone-1"), true);
      assert.equal(await store.add(device), "pairing-device-revoked");
      assert.equal(
        await store.add({ ...device, deviceId: "phone-2" }),
        undefined,
      );
      assert.equal(await store.removeAll(), 1);
    } finally {
      await store.close();
    }
    await assert.rejects(
      store.add({
        deviceId: "phone-3",
        name: "Late",
        platform: "ios",
        agreementPublicKey: "a",
        answerPublicKey: "b",
        approvalPublicKey: "c",
        pairedAt: "2026-10-25T12:00:00Z",
        state: "checking",
        removedAt: null,
      }),
    );
  });
});

await test("CLV-189 the request checks refuse missing fields, long names and other platforms", () => {
  const secret = Buffer.from(fixture.secret, "base64url");
  const link = fixture.link;
  assert.deepEqual(checkedRequest(secret, null), {
    kind: "refused",
    code: "pairing-request-invalid",
  });
  assert.deepEqual(checkedRequest(secret, { device_id: "x" }), {
    kind: "refused",
    code: "pairing-request-invalid",
  });
  for (const values of [{ name: "n".repeat(65) }, { platform: "windows" }])
    assert.deepEqual(checkedRequest(secret, phoneRequestBody(link, values)), {
      kind: "refused",
      code: "pairing-request-invalid",
    });
  assert.deepEqual(
    checkedRequest(secret, phoneRequestBody(link, { mac: "short" })),
    {
      kind: "refused",
      code: "pairing-mac-invalid",
    },
  );
  const valid = checkedRequest(secret, {
    ...fixture.request,
    mac: fixture.mac,
  });
  assert.equal(valid.kind === "valid" ? valid.request.code : "", fixture.code);
});

await test("CLV-189 the check refuses a missing field, another key, an old time and another device", () => {
  const expected = {
    daemonId: fixture.daemon.id,
    deviceId: fixture.device.id,
    nonce: fixture.receiptNonce,
    answerPublicKey: fixture.device.answerPublicKey,
    now: Date.parse(fixture.checkSignedAt),
  };
  assert.equal(checkValid(fixture.check, expected), true);
  assert.equal(checkValid({ payload: fixture.check.payload }, expected), false);
  assert.equal(
    checkValid(fixture.check, {
      ...expected,
      answerPublicKey: fixture.device.approvalPublicKey,
    }),
    false,
  );
  assert.equal(
    checkValid(fixture.check, { ...expected, answerPublicKey: "bad" }),
    false,
  );
  assert.equal(
    checkValid(fixture.check, { ...expected, now: expected.now + 3_600_000 }),
    false,
  );
  assert.equal(
    checkValid(fixture.check, { ...expected, deviceId: "other" }),
    false,
  );
});

await test("CLV-189 an expiry after Accept keeps the device checking with no refusal", async () => {
  await withRelay({}, async (setup) => {
    const pairingId = await requested(setup);
    await call(setup, { operation: "phone-pair-accept" });
    setup.server.change(pairingId, { stage: "expired" });
    const ended = await until(setup, (current) => current["pairing"] === null);
    assert.equal(ended["refusal"], null);
    assert.deepEqual(
      Array.isArray(ended["devices"])
        ? ended["devices"].map((device: unknown) => record(device)?.["state"])
        : [],
      ["checking"],
    );
  });
});

await test("CLV-189 a check before Accept is ignored, and the relay keeps the pairing when cloving.ai does not answer", async () => {
  await withRelay({}, async (setup) => {
    const pairingId = await requested(setup);
    setup.server.change(pairingId, {
      stage: "checked",
      check: { payload: "{}", signature: "x" },
    });
    await new Promise((settle) => setTimeout(settle, 200));
    assert.equal(stage(await state(setup)), "requested");
    await setup.server.close();
    await new Promise((settle) => setTimeout(settle, 1500));
    assert.equal(stage(await state(setup)), "requested");
    assert.equal(code(await call(setup, { operation: "phone-pair-deny" })), "");
  });
});

await test("CLV-189 a pairing ends with pairing-failed when its follow loop fails", async () => {
  const server = await fakeRelayServer();
  try {
    const registered = await relayRequest(server.origin, {
      method: "POST",
      path: "/api/v1/relay/daemons",
      body: {},
    });
    const sessions = pairingSessions({
      secret: () => Buffer.from(fixture.secret, "base64url"),
      follow: () => Promise.reject(new Error("follow-failed")),
    });
    await sessions.start({
      keys: newDaemonKeys(),
      link: {
        daemonId: String(record(registered.body)?.["daemon_id"]),
        origin: server.origin,
        token: String(record(registered.body)?.["token"]),
        registeredAt: "2026-10-25T12:00:00Z",
      },
    });
    await new Promise((settle) => setTimeout(settle, 20));
    assert.equal(sessions.current(), undefined);
    assert.equal(sessions.refusal(), "pairing-failed");
  } finally {
    await server.close();
  }
});

await test("CLV-189 phone-reset keeps going and warns when cloving.ai does not answer", async () => {
  await withRelay({}, async (setup) => {
    await requested(setup);
    await setup.server.close();
    const reply = await call(setup, { operation: "phone-reset" });
    assert.equal(reply?.kind, "result", JSON.stringify(reply));
    assert.match(
      String(reply.result["warning"]),
      /^cloving.ai did not remove this computer \(answer 0\)/,
    );
    assert.equal((await state(setup))["registered"], false);
  });
});
