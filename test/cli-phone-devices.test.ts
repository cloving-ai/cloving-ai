import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { phoneRequest } from "../src/cli/phone-client.ts";
import { record } from "../src/protocol.ts";
import { startRelay } from "../src/relay/relay-service.ts";
import fixture from "./fixtures/phone-pairing.json" with { type: "json" };
import { sendPhoneCheck, sendPhoneRequest } from "./phone-fake-phone.ts";
import {
  fakeRelayServer,
  type FakeRelayServer,
} from "./phone-relay-server-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";

interface Run {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function cloving(
  runtimeDirectory: string,
  argumentsList: readonly string[],
): Promise<Run> {
  try {
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      [resolve("src/cli.ts"), "phone", ...argumentsList],
      {
        env: { ...process.env, CLOVING_RUNTIME_DIR: runtimeDirectory },
        encoding: "utf8",
      },
    );
    return { status: 0, stdout, stderr };
  } catch (error) {
    return {
      status: Number(Reflect.get(Object(error), "code")),
      stdout: String(Reflect.get(Object(error), "stdout")),
      stderr: String(Reflect.get(Object(error), "stderr")),
    };
  }
}

async function operation(
  runtimeDirectory: string,
  request: { readonly name: string; readonly pairingId?: string },
) {
  const reply = await phoneRequest(runtimeDirectory, {
    operation: request.name,
    parameters:
      request.pairingId === undefined ? {} : { pairingId: request.pairingId },
  });
  assert.equal(reply?.kind, "result", JSON.stringify(reply));
  return reply.result;
}

async function connected(
  runtimeDirectory: string,
  server: FakeRelayServer,
): Promise<void> {
  const started = await operation(runtimeDirectory, {
    name: "phone-pair-start",
  });
  const pairingId = sendPhoneRequest(server, { link: String(started["link"]) });
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const state = await operation(runtimeDirectory, { name: "phone-state" });
    if (Reflect.get(Object(state["pairing"]), "stage") === "requested") break;
    await new Promise((settle) => setTimeout(settle, 20));
  }
  await operation(runtimeDirectory, { name: "phone-pair-accept", pairingId });
  sendPhoneCheck(server, { pairingId });
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const state = await operation(runtimeDirectory, { name: "phone-state" });
    if (state["pairing"] === null) return;
    await new Promise((settle) => setTimeout(settle, 20));
  }
}

async function removedAndReset(
  runtimeDirectory: string,
  context: {
    readonly server: FakeRelayServer;
    readonly phoneDirectory: string;
  },
): Promise<void> {
  const text = await cloving(runtimeDirectory, ["list"]);
  assert.match(
    text.stdout,
    new RegExp(
      `^${fixture.device.id} {2}Pixel 8a \\(android\\) {2}connected {2}paired \\d{4}-`,
    ),
  );
  const removed = await cloving(runtimeDirectory, [
    "remove",
    fixture.device.id,
  ]);
  assert.deepEqual(removed, {
    status: 0,
    stdout: `Removed the phone ${fixture.device.id}.\n`,
    stderr: "",
  });
  assert.match(
    (await cloving(runtimeDirectory, ["list"])).stdout,
    /removed \d{4}-/,
  );
  const unknown = await cloving(runtimeDirectory, ["remove", "nobody"]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /^phone-unknown: /);
  const reset = await cloving(runtimeDirectory, ["reset", "--json"]);
  assert.equal(reset.status, 0);
  assert.deepEqual(JSON.parse(reset.stdout), { removed: 0, warning: null });
  const again = await cloving(runtimeDirectory, ["reset"]);
  assert.equal(again.stdout, "Removed the registration and 0 phones.\n");
  for (const file of ["link.json", "daemon-keys.json"])
    await assert.rejects(stat(join(context.phoneDirectory, file)), {
      code: "ENOENT",
    });
  assert.ok(
    context.server.requests.some(
      (request) =>
        request.method === "DELETE" && request.path === "/api/v1/relay/daemon",
    ),
  );
}

await test("CLV-189 phone list shows the devices, phone remove marks one removed, and phone reset removes the registration", async () => {
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
      assert.equal(
        (await cloving(runtimeDirectory, ["list"])).stdout,
        "No phones.\n",
      );
      await connected(runtimeDirectory, server);
      const listed = await cloving(runtimeDirectory, ["list", "--json"]);
      const devices: unknown = Reflect.get(
        Object(JSON.parse(listed.stdout)),
        "devices",
      );
      assert.ok(Array.isArray(devices));
      assert.deepEqual(
        devices.map((device: unknown) => {
          const fields = record(device);
          return [
            fields?.["deviceId"],
            fields?.["state"],
            fields?.["removedAt"],
          ];
        }),
        [[fixture.device.id, "connected", null]],
      );
      await removedAndReset(runtimeDirectory, { server, phoneDirectory });
    } finally {
      await relay.close();
      await server.close();
    }
  });
});

await test("CLV-189 phone remove keeps the tombstone and warns when cloving.ai refuses", async () => {
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
      await connected(runtimeDirectory, server);
      server.revoke("token-1");
      const removed = await cloving(runtimeDirectory, [
        "remove",
        fixture.device.id,
      ]);
      assert.equal(removed.status, 0);
      assert.match(
        removed.stderr,
        /^warning: cloving.ai did not remove the phone \(answer 401\)/,
      );
      assert.match(
        (await cloving(runtimeDirectory, ["list"])).stdout,
        /removed \d{4}-/,
      );
    } finally {
      await relay.close();
      await server.close();
    }
  });
});

await test("CLV-189 the device commands need a running relay and a device ID", async () => {
  await withFiles({}, async (root) => {
    const runtimeDirectory = join(root, "run");
    const off = await cloving(runtimeDirectory, ["list"]);
    assert.equal(off.status, 1);
    assert.match(off.stderr, /^phone-relay-off: /);
    const missing = await cloving(runtimeDirectory, ["remove"]);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /^missing-argument: /);
    const help = await cloving(runtimeDirectory, ["--help"]);
    assert.match(help.stdout, /cloving phone remove <device-id>/);
    assert.match(help.stdout, /cloving phone reset/);
  });
});
