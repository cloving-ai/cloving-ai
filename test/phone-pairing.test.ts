import assert from "node:assert/strict";
import { createPrivateKey } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { phoneRequest } from "../src/cli/phone-client.ts";
import { relayOrigin } from "../src/relay/relay-http.ts";
import { runRelay, startRelay } from "../src/relay/relay-service.ts";
import { withFiles } from "./quality/files-fixture.ts";
import fixture from "./fixtures/phone-pairing.json" with { type: "json" };
import { fakeRelayServer } from "./phone-relay-server-fixture.ts";

async function mode(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

function operation(name: string) {
  return { operation: name, parameters: {} };
}

async function result(
  runtimeDirectory: string,
  name: string,
): Promise<Readonly<Record<string, unknown>>> {
  const reply = await phoneRequest(runtimeDirectory, operation(name));
  assert.equal(reply?.kind, "result", JSON.stringify(reply));
  return reply.result;
}

function pkcs8(scalar: string, point: string): string {
  const raw = Buffer.from(point, "base64url");
  return createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      d: scalar,
      x: raw.subarray(1, 33).toString("base64url"),
      y: raw.subarray(33).toString("base64url"),
    },
    format: "jwk",
  })
    .export({ format: "der", type: "pkcs8" })
    .toString("base64url");
}

await test("CLV-188 the first pairing start registers the daemon with private files, and a second start keeps the registration", async () => {
  await withFiles({}, async (root) => {
    const server = await fakeRelayServer();
    const runtimeDirectory = join(root, "run");
    const phoneDirectory = join(root, "state/phone");
    const relay = await startRelay({
      runtimeDirectory,
      phoneDirectory,
      origin: server.origin,
      computerName: "Studio",
    });
    try {
      const first = await result(runtimeDirectory, "phone-pair-start");
      assert.match(
        String(first["link"]),
        new RegExp(`^${server.origin}/pair#v1\\.[A-Za-z0-9_-]{43}$`),
      );
      assert.equal(typeof first["expiresAt"], "string");
      assert.equal(await mode(phoneDirectory), 0o700);
      assert.equal(await mode(join(phoneDirectory, "link.json")), 0o600);
      assert.equal(await mode(join(phoneDirectory, "daemon-keys.json")), 0o600);
      assert.equal(server.daemons.length, 1);
      const [daemon] = server.daemons;
      assert.ok(daemon !== undefined);
      assert.equal(daemon.name, "Studio");
      assert.match(
        String(daemon.signingPublicKey),
        /^B[A-P][A-Za-z0-9_-]{85}$/,
      );
      const state = await result(runtimeDirectory, "phone-state");
      assert.equal(state["registered"], true);
      assert.equal(state["daemonId"], "dmn_test1");
      assert.equal(JSON.stringify(state).includes("/pair#"), false);
      assert.equal(server.pairings.size, 1);
      await result(runtimeDirectory, "phone-pair-cancel");
      assert.equal(
        (await result(runtimeDirectory, "phone-state"))["pairing"],
        null,
      );
      await result(runtimeDirectory, "phone-pair-start");
      assert.equal(server.daemons.length, 1);
      assert.equal(server.pairings.size, 2);
      const tokens = server.requests
        .filter((request) => request.path === "/api/v1/relay/pairings")
        .map((request) => request.authorization);
      assert.deepEqual(tokens, ["Bearer token-1", "Bearer token-1"]);
    } finally {
      await relay.close();
      await server.close();
    }
  });
});

await test("CLV-188 the pairing ID and link of the fixture secret and keys, and the server never gets the secret", async () => {
  await withFiles({}, async (root) => {
    const server = await fakeRelayServer();
    const runtimeDirectory = join(root, "run");
    const phoneDirectory = join(root, "state/phone");
    await mkdir(phoneDirectory, { recursive: true, mode: 0o700 });
    const { daemon } = fixture;
    await writeFile(
      join(phoneDirectory, "daemon-keys.json"),
      JSON.stringify({
        agreementPrivateKey: pkcs8(
          daemon.agreementPrivateKey,
          daemon.agreementPublicKey,
        ),
        agreementPublicKey: daemon.agreementPublicKey,
        signingPrivateKey: pkcs8(
          daemon.signingPrivateKey,
          daemon.signingPublicKey,
        ),
        signingPublicKey: daemon.signingPublicKey,
      }),
      { mode: 0o600 },
    );
    const relay = await startRelay({
      runtimeDirectory,
      phoneDirectory,
      origin: server.origin,
      computerName: fixture.computerName,
      secret: () => Buffer.from(fixture.secret, "base64url"),
    });
    try {
      const started = await result(runtimeDirectory, "phone-pair-start");
      assert.equal(
        started["link"],
        fixture.link.replace("https://cloving.ai", server.origin),
      );
      assert.deepEqual([...server.pairings.keys()], [fixture.pairingId]);
      assert.equal(
        server.daemons[0]?.signingPublicKey,
        daemon.signingPublicKey,
      );
      const sent = JSON.stringify(server.requests);
      const secret = Buffer.from(fixture.secret, "base64url");
      for (const form of [
        secret.toString("base64url"),
        secret.toString("hex"),
        secret.toString("base64"),
      ])
        assert.equal(sent.includes(form), false, form);
    } finally {
      await relay.close();
      await server.close();
    }
  });
});

await test("CLV-188 a 401 reply removes the registration, and the start registers again", async () => {
  await withFiles({}, async (root) => {
    const server = await fakeRelayServer();
    const runtimeDirectory = join(root, "run");
    const relay = await startRelay({
      runtimeDirectory,
      phoneDirectory: join(root, "state/phone"),
      origin: server.origin,
      computerName: "Studio",
    });
    try {
      await result(runtimeDirectory, "phone-pair-start");
      await result(runtimeDirectory, "phone-pair-cancel");
      server.revoke("token-1");
      await result(runtimeDirectory, "phone-pair-start");
      assert.deepEqual(
        server.daemons.map((daemon) => daemon.daemonId),
        ["dmn_test1", "dmn_test2"],
      );
      assert.equal(
        server.daemons[0]?.signingPublicKey,
        server.daemons[1]?.signingPublicKey,
      );
      const state = await result(runtimeDirectory, "phone-state");
      assert.equal(state["daemonId"], "dmn_test2");
    } finally {
      await relay.close();
      await server.close();
    }
  });
});

await test("CLV-188 the open pairing ends at its expiry", async () => {
  await withFiles({}, async (root) => {
    const server = await fakeRelayServer({ pairingMilliseconds: 300 });
    const runtimeDirectory = join(root, "run");
    const relay = await startRelay({
      runtimeDirectory,
      phoneDirectory: join(root, "state/phone"),
      origin: server.origin,
      computerName: "Studio",
    });
    try {
      const started = await result(runtimeDirectory, "phone-pair-start");
      const open = await result(runtimeDirectory, "phone-state");
      assert.deepEqual(open["pairing"], {
        pairingId: [...server.pairings.keys()][0],
        expiresAt: started["expiresAt"],
        stage: "open",
        request: null,
      });
      await new Promise((settle) => setTimeout(settle, 500));
      assert.equal(
        (await result(runtimeDirectory, "phone-state"))["pairing"],
        null,
      );
    } finally {
      await relay.close();
      await server.close();
    }
  });
});

await test("CLV-188 the relay accepts only https origins, and http://127.0.0.1 for tests", async () => {
  assert.equal(relayOrigin(undefined), "https://cloving.ai");
  assert.equal(
    relayOrigin("https://staging.cloving.ai"),
    "https://staging.cloving.ai",
  );
  assert.equal(relayOrigin("http://127.0.0.1:4567"), "http://127.0.0.1:4567");
  const longest = `https://${"a".repeat(150)}.ai`;
  assert.equal(longest.length, 161);
  assert.equal(relayOrigin(longest), longest);
  for (const origin of [
    "http://cloving.ai",
    "http://localhost:3000",
    "https://cloving.ai/",
    "https://cloving.ai/api",
    "ftp://cloving.ai",
    "cloving.ai",
    `https://${"a".repeat(155)}.ai`,
  ])
    assert.throws(
      () => relayOrigin(origin),
      /^Error: relay-origin-invalid: /,
      origin,
    );
  await withFiles({}, async (root) => {
    const errors: string[] = [];
    const status = await runRelay(
      {
        CLOVING_RUNTIME_DIR: join(root, "run"),
        CLOVING_RELAY_ORIGIN: "http://cloving.ai",
      },
      { stopped: Promise.resolve(), error: (line) => errors.push(line) },
    );
    assert.equal(status, 1);
    assert.match(errors.join(""), /relay-origin-invalid: /);
  });
});

await test("CLV-188 a failed registration answers an error and writes no files", async () => {
  await withFiles({}, async (root) => {
    const runtimeDirectory = join(root, "run");
    const phoneDirectory = join(root, "state/phone");
    const relay = await startRelay({
      runtimeDirectory,
      phoneDirectory,
      origin: "http://127.0.0.1:9",
      computerName: "Studio",
    });
    try {
      const reply = await phoneRequest(
        runtimeDirectory,
        operation("phone-pair-start"),
      );
      assert.equal(reply?.kind, "error");
      await assert.rejects(stat(join(phoneDirectory, "link.json")), {
        code: "ENOENT",
      });
    } finally {
      await relay.close();
    }
  });
});
