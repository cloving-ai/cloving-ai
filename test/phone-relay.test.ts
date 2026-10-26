import assert from "node:assert/strict";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { phoneRequest } from "../src/cli/phone-client.ts";
import { runRelay, startRelay } from "../src/relay/relay-service.ts";
import { withFiles } from "./quality/files-fixture.ts";

const state = { operation: "phone-state", parameters: {} };

async function mode(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

await test("CLV-187 the relay serves phone-state on a private phone.sock with a private store", async () => {
  await withFiles({}, async (root) => {
    const runtimeDirectory = join(root, "run");
    const relay = await startRelay({
      runtimeDirectory,
      phoneDirectory: join(root, "state/phone"),
    });
    try {
      assert.equal(await mode(join(runtimeDirectory, "phone.sock")), 0o600);
      assert.equal(await mode(join(root, "state/phone")), 0o700);
      assert.equal(await mode(join(root, "state/phone/relay.sqlite3")), 0o600);
      assert.deepEqual(await phoneRequest(runtimeDirectory, state), {
        kind: "result",
        result: {
          registered: false,
          daemonId: null,
          origin: null,
          pairing: null,
          refusal: null,
          reason: null,
          devices: [],
        },
      });
    } finally {
      await relay.close();
    }
  });
});

await test("CLV-187 phone-state reads the registration from phone/link.json", async () => {
  await withFiles({}, async (root) => {
    const phoneDirectory = join(root, "state/phone");
    await mkdir(phoneDirectory, { recursive: true, mode: 0o700 });
    await writeFile(
      join(phoneDirectory, "link.json"),
      JSON.stringify({
        daemonId: "dmn_fixture01",
        origin: "https://cloving.ai",
        token: "relay-token",
        registeredAt: "2026-10-25T12:00:00Z",
      }),
      { mode: 0o600 },
    );
    const relay = await startRelay({
      runtimeDirectory: join(root, "run"),
      phoneDirectory,
    });
    try {
      const reply = await phoneRequest(join(root, "run"), state);
      assert.deepEqual(reply, {
        kind: "result",
        result: {
          registered: true,
          daemonId: "dmn_fixture01",
          origin: "https://cloving.ai",
          pairing: null,
          refusal: null,
          reason: null,
          devices: [],
        },
      });
      assert.equal(JSON.stringify(reply).includes("relay-token"), false);
    } finally {
      await relay.close();
    }
  });
});

await test("CLV-187 the relay refuses an unknown operation and a broken request", async () => {
  await withFiles({}, async (root) => {
    const runtimeDirectory = join(root, "run");
    const relay = await startRelay({
      runtimeDirectory,
      phoneDirectory: join(root, "state/phone"),
    });
    try {
      const unknown = await phoneRequest(runtimeDirectory, {
        operation: "phone-launch",
        parameters: {},
      });
      assert.equal(
        unknown?.kind === "error" ? unknown.error.code : "",
        "unknown-operation",
      );
    } finally {
      await relay.close();
    }
  });
});

await test("CLV-187 phoneRequest reports no relay when phone.sock is missing", async () => {
  await withFiles({}, async (root) => {
    assert.equal(await phoneRequest(join(root, "run"), state), undefined);
  });
});

await test("CLV-187 the relay program needs the runtime directory and stops on its signal", async () => {
  await withFiles({}, async (root) => {
    const errors: string[] = [];
    assert.equal(
      await runRelay(
        {},
        { stopped: Promise.resolve(), error: (line) => errors.push(line) },
      ),
      1,
    );
    assert.match(errors.join(""), /^runtime-directory-unknown: /);
    const blocked = join(root, "blocked");
    await writeFile(blocked, "a file");
    assert.equal(
      await runRelay(
        { CLOVING_RUNTIME_DIR: join(blocked, "run") },
        { stopped: Promise.resolve(), error: (line) => errors.push(line) },
      ),
      1,
    );
    assert.match(errors.at(-1) ?? "", /^phone-relay-failed: /);
    const stop = Promise.withResolvers<undefined>();
    const running = runRelay(
      { CLOVING_RUNTIME_DIR: join(root, "run") },
      { stopped: stop.promise, error: (line) => errors.push(line) },
    );
    await waitForSocket(join(root, "run"));
    assert.equal(await mode(join(root, "state/phone/relay.sqlite3")), 0o600);
    stop.resolve(undefined);
    assert.equal(await running, 0);
    assert.equal(await phoneRequest(join(root, "run"), state), undefined);
  });
});

async function waitForSocket(runtimeDirectory: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if ((await phoneRequest(runtimeDirectory, state)) !== undefined) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("phone-socket-timed-out");
}
