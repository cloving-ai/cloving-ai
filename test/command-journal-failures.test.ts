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

await test("CLV-178 synchronous spawn failures close stderr and remove command configuration", () => {
  commandScenario(`
import assert from "node:assert/strict";
import filesystem from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { startCommand } from ${JSON.stringify(new URL("../src/daemon/command-process.ts", import.meta.url).href)};
import { withCommandScene } from ${JSON.stringify(new URL("./command-worker-fixture.ts", import.meta.url).href)};
await withCommandScene(async (scene) => {
  const open = filesystem.openSync;
  const descriptors = [];
  filesystem.openSync = (...args) => {
    const descriptor = open(...args);
    descriptors.push(descriptor);
    return descriptor;
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => startCommand({
      command: [""], directory: scene.directory, folder: scene.directory,
      payload: "{}", runId: "run-1", operationId: "operation-1", seconds: 60,
    }), { code: "ERR_INVALID_ARG_VALUE" });
    assert.equal(descriptors.length, 1, "open the stderr journal before spawning");
    assert.throws(() => filesystem.fstatSync(descriptors[0]), { code: "EBADF" });
    assert.deepEqual(filesystem.readdirSync(scene.directory), ["command.stderr.log"]);
  } finally {
    filesystem.openSync = open;
    syncBuiltinESMExports();
  }
});
`);
});

await test("CLV-178 stderr journal write failures stop the command and preserve worker replay without crashing", () => {
  commandScenario(`
import assert from "node:assert/strict";
import filesystem from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { commandIntent, signal, withCommandScene } from ${JSON.stringify(new URL("./command-worker-fixture.ts", import.meta.url).href)};
import { until } from ${JSON.stringify(new URL("./claude-worker-fixture.ts", import.meta.url).href)};
await withCommandScene(async (scene) => {
  const worker = scene.worker('process.stderr.write("private detail"); setTimeout(() => process.stdout.write("too late"), 1000);');
  const write = filesystem.writeSync;
  let failed = false;
  filesystem.writeSync = () => {
    failed = true;
    filesystem.writeSync = write;
    syncBuiltinESMExports();
    throw Object.assign(new Error("journal disk full"), { code: "ENOSPC" });
  };
  syncBuiltinESMExports();
  try {
    await worker.deliver(commandIntent(), signal);
    await until(() => scene.reports.length === 1);
    assert.equal(failed, true);
    assert.equal(scene.reports[0].outcome, "failed");
    assert.equal(scene.reports[0].reason, "command-exit");
    assert.equal(scene.reports[0].result, undefined);
    assert.equal((await worker.deliver(commandIntent(), signal)).kind, "failed");
    const healthy = scene.worker('process.stdout.write("healthy");');
    await healthy.deliver(commandIntent({ operationId: "operation-2" }), signal);
    await until(() => scene.reports.length === 2);
    assert.equal(scene.reports[1].result, "healthy");
  } finally {
    filesystem.writeSync = write;
    syncBuiltinESMExports();
  }
});
`);
});
