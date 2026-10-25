import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

await test("CLV-178 stderr journal write failures stop the command and preserve worker replay without crashing", () => {
  const scenario = `
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
`;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", scenario],
    {
      encoding: "utf8",
      timeout: 15000,
    },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
