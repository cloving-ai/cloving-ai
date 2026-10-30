import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { test } from "node:test";
import { withDoctor } from "./doctor-fixture.ts";
import { stopChildGroup } from "./stop-child.ts";

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  await test(`CLV-209 init waits for a harness that handles ${signal}`, () =>
    withDoctor(async (scene) => {
      const file = await scene.program(
        "fake",
        `if (process.argv[2] === "--version") console.log("1.0.0");
else {
  let interruptions = 0;
  process.on(${JSON.stringify(signal)}, () => { interruptions++; console.log("interrupted"); });
  process.stdin.once("data", () => { setImmediate(() => process.exit(interruptions === 1 ? 7 : 99)); });
  console.log("ready");
}`,
      );
      const child = spawn(
        process.execPath,
        [resolve("src/cli.ts"), "init", "--harness", file],
        {
          cwd: scene.repository,
          env: scene.environment,
          detached: true,
        },
      );
      const closed = once(child, "close");
      try {
        const ready = await once(child.stdout, "data", {
          signal: AbortSignal.timeout(10000),
        });
        assert.match(String(ready[0]), /ready/);
        const interrupted = once(child.stdout, "data", {
          signal: AbortSignal.timeout(2000),
        });
        assert.ok(child.pid);
        if (signal === "SIGINT") process.kill(-child.pid, signal);
        else child.kill(signal);
        assert.match(String((await interrupted)[0]), /interrupted/);
        assert.equal(child.exitCode, null);
        assert.equal(child.signalCode, null);
        child.stdin.end("finish\n");
        assert.deepEqual(await closed, [7, null]);
      } finally {
        await stopChildGroup(child, { graceMilliseconds: 50 });
      }
    }));
}
