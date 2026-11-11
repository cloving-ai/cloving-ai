import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

function commandScenario(scenario: string): void {
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", scenario],
    {
      encoding: "utf8",
      timeout: 15000,
    },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

await test("CLV-178 stderr journal open failures prevent spawning and clean command configuration", () => {
  commandScenario(`
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { withCommandScene } from ${JSON.stringify(new URL("./command-worker-fixture.ts", import.meta.url).href)};
import { startCommand } from ${JSON.stringify(new URL("../src/daemon/command-process.ts", import.meta.url).href)};
await withCommandScene(async (scene) => {
  const folder = scene.directory;
  mkdirSync(join(folder, "command.stderr.log"), { recursive: true });
  const spawn = childProcess.spawn;
  const children = [];
  childProcess.spawn = (...args) => {
    const child = spawn(...args);
    children.push(child);
    return child;
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => startCommand({
      command: [process.execPath, "-e", "setInterval(() => {}, 1000);"],
      directory: scene.directory, folder, payload: "{}",
      runId: "run-1", operationId: "operation-1", seconds: 60,
    }), { code: "EISDIR" });
    assert.equal(children.length, 0, "a failed log open must not start the command");
    assert.deepEqual(readdirSync(folder).filter((name) => name.startsWith("gh-config-")), []);
  } finally {
    childProcess.spawn = spawn;
    syncBuiltinESMExports();
    for (const child of children) child.kill("SIGKILL");
  }
});
`);
});

await test("CLV-337 a synchronous spawn failure of the start program closes each journal file and removes the command configuration", () => {
  commandScenario(`
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import filesystem from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { startCommand } from ${JSON.stringify(new URL("../src/daemon/command-process.ts", import.meta.url).href)};
import { withCommandScene } from ${JSON.stringify(new URL("./command-worker-fixture.ts", import.meta.url).href)};
await withCommandScene(async (scene) => {
  const open = filesystem.openSync;
  const spawn = childProcess.spawn;
  const descriptors = [];
  filesystem.openSync = (...args) => {
    const descriptor = open(...args);
    descriptors.push(descriptor);
    return descriptor;
  };
  childProcess.spawn = () => {
    throw Object.assign(new Error("no process slot"), { code: "EAGAIN" });
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => startCommand({
      command: [process.execPath, "-e", "setInterval(() => {}, 1000);"],
      directory: scene.directory, folder: scene.directory,
      payload: "{}", runId: "run-1", operationId: "operation-1", seconds: 60,
    }), { code: "EAGAIN" });
    assert.ok(descriptors.length >= 3, "open the stderr, stdout and input files before the start");
    for (const descriptor of descriptors)
      assert.throws(() => filesystem.fstatSync(descriptor), { code: "EBADF" });
    assert.deepEqual(filesystem.readdirSync(scene.directory).sort(), ["command.stderr.log", "command.stdout"]);
  } finally {
    filesystem.openSync = open;
    childProcess.spawn = spawn;
    syncBuiltinESMExports();
  }
});
`);
});

await test("CLV-337 an input file write failure starts no command, and a later delivery replays the interruption without a crash", () => {
  commandScenario(`
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import filesystem from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { located } from ${JSON.stringify(new URL("../src/daemon/operation-journal.ts", import.meta.url).href)};
import { commandIntent, signal, withCommandScene } from ${JSON.stringify(new URL("./command-worker-fixture.ts", import.meta.url).href)};
import { until } from ${JSON.stringify(new URL("./claude-worker-fixture.ts", import.meta.url).href)};
await withCommandScene(async (scene) => {
  const worker = scene.worker('require("node:fs").writeFileSync("ran", "");');
  const write = filesystem.writeFileSync;
  filesystem.writeFileSync = () => {
    throw Object.assign(new Error("journal disk full"), { code: "ENOSPC" });
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(worker.deliver(commandIntent(), signal), { code: "ENOSPC" });
  } finally {
    filesystem.writeFileSync = write;
    syncBuiltinESMExports();
  }
  const folder = located(scene.journal, "operation-1").folder;
  assert.deepEqual(readdirSync(folder).sort(), ["command.stderr.log", "command.stdout", "started.json"]);
  const replay = await worker.deliver(commandIntent(), signal);
  assert.equal(replay.kind, "failed");
  assert.equal(replay.reason, "command-interrupted");
  assert.equal(existsSync(join(scene.directory, "ran")), false);
  const healthy = scene.worker('process.stdout.write("healthy");');
  await healthy.deliver(commandIntent({ operationId: "operation-2" }), signal);
  await until(() => scene.reports.length === 1);
  assert.equal(scene.reports[0].result, "healthy");
});
`);
});
