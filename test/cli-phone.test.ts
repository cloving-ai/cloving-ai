import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { phoneRequest } from "../src/cli/phone-client.ts";
import { startRelay } from "../src/relay/relay-service.ts";
import { withFiles } from "./quality/files-fixture.ts";

const cli = resolve("src/cli.ts");

async function executed(
  argumentsList: readonly string[],
  runtimeDirectory: string,
): Promise<{ status: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      argumentsList,
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

function cloving(
  runtimeDirectory: string,
  argumentsList: readonly string[],
): ReturnType<typeof executed> {
  return executed([cli, ...argumentsList], runtimeDirectory);
}

await test("CLV-187 phone status shows the relay state, or that the relay is off", async () => {
  await withFiles({}, async (root) => {
    const runtimeDirectory = join(root, "run");
    const off = await cloving(runtimeDirectory, ["phone", "status", "--json"]);
    assert.equal(off.status, 0);
    assert.deepEqual(JSON.parse(off.stdout), { relay: "off" });
    const offText = await cloving(runtimeDirectory, ["phone", "status"]);
    assert.equal(offText.stdout, "The phone relay is off or not started.\n");
    const relay = await startRelay({
      runtimeDirectory,
      phoneDirectory: join(root, "state/phone"),
    });
    try {
      const on = await cloving(runtimeDirectory, ["phone", "status", "--json"]);
      assert.equal(on.status, 0);
      assert.deepEqual(JSON.parse(on.stdout), {
        relay: "on",
        registered: false,
        daemonId: null,
        origin: null,
        pairing: null,
        refusal: null,
        reason: null,
        devices: [],
      });
      const text = await cloving(runtimeDirectory, ["phone", "status"]);
      assert.equal(text.stdout, "Not registered. 0 phones.\n");
    } finally {
      await relay.close();
    }
  });
});

await test("CLV-187 phone help and phone usage errors", async () => {
  await withFiles({}, async (root) => {
    const runtimeDirectory = join(root, "run");
    const help = await cloving(runtimeDirectory, ["phone", "--help"]);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /^Usage: cloving phone status \[--json\]/);
    assert.match(help.stdout, /cloving start/);
    const unknown = await cloving(runtimeDirectory, ["phone", "launch"]);
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /^unknown-command: /);
    const extra = await cloving(runtimeDirectory, [
      "phone",
      "status",
      "--port",
      "1",
    ]);
    assert.equal(extra.status, 2);
    assert.match(extra.stderr, /^unexpected-option: /);
    assert.match(
      (await cloving(runtimeDirectory, ["--help"])).stdout,
      /\n {2}phone {6}/,
    );
  });
});

await test("CLV-187 the relay program serves phone.sock until SIGTERM", async () => {
  await withFiles({}, async (root) => {
    const runtimeDirectory = join(root, "run");
    const child = spawn(process.execPath, [resolve("src/relay.ts")], {
      env: { ...process.env, CLOVING_RUNTIME_DIR: runtimeDirectory },
      stdio: "inherit",
    });
    const ended = new Promise<number | null>((settle) => {
      child.once("close", settle);
    });
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      const reply = await phoneRequest(runtimeDirectory, {
        operation: "phone-state",
        parameters: {},
      });
      if (reply !== undefined) break;
      await new Promise((settle) => setTimeout(settle, 10));
    }
    const status = await cloving(runtimeDirectory, ["phone", "status"]);
    assert.equal(status.stdout, "Not registered. 0 phones.\n");
    child.kill("SIGTERM");
    assert.equal(await ended, 0);
    const unnamed = await executed([resolve("src/relay.ts")], "");
    assert.equal(unnamed.status, 1);
    assert.match(unnamed.stderr, /^runtime-directory-unknown: /);
  });
});
