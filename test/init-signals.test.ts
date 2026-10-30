import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
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

const shellAgent = `
if (process.argv[2] === "--version") console.log("1.0.0");
else {
  const { spawn } = require("node:child_process");
  const worker = spawn(process.execPath, ["-e", \`
    let interruptions = 0;
    process.on("SIGTERM", () => { interruptions++; console.log("worker-interrupted"); });
    process.on("message", () => process.exit(interruptions === 1 ? 7 : 99));
    process.send("ready");
  \`], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
  let interruptions = 0;
  process.on("SIGTERM", () => { interruptions++; console.log("agent-interrupted"); });
  worker.once("message", () => console.log("ready"));
  process.stdin.once("data", () => worker.send("finish"));
  worker.once("close", status => process.exit(interruptions === 1 && status === 7 ? 7 : 99));
}
`;

for (const shell of ["/bin/bash", "/bin/zsh"]) {
  await test(`CLV-209 init forwards SIGTERM through ${shell} functions to agents and workers`, () =>
    withDoctor(async (scene) => {
      const file = await scene.program("receiver", shellAgent);
      const definition = `custom() { "${file}" "$@"; }\n`;
      for (const name of [".bash_profile", ".zshrc"])
        await writeFile(join(scene.root, name), definition);
      const child = spawn(
        process.execPath,
        [resolve("src/cli.ts"), "init", "--harness", "shell:custom"],
        {
          cwd: scene.repository,
          env: { ...scene.environment, SHELL: shell, ZDOTDIR: scene.root },
          detached: true,
        },
      );
      const closed = once(child, "close");
      const output = createInterface({ input: child.stdout });
      const lines = output[Symbol.asyncIterator]();
      const deadline = AbortSignal.timeout(10000);
      try {
        assert.equal((await lines.next()).value, "ready");
        child.kill("SIGTERM");
        const interruptions = await Promise.race([
          (async () => [
            (await lines.next()).value,
            (await lines.next()).value,
          ])(),
          once(deadline, "abort").then(() => {
            throw new Error("shell agent missed SIGTERM");
          }),
        ]);
        assert.deepEqual(interruptions.sort(), [
          "agent-interrupted",
          "worker-interrupted",
        ]);
        assert.equal(child.exitCode, null);
        child.stdin.end("finish\n");
        assert.deepEqual(await closed, [7, null]);
      } finally {
        output.close();
        await stopChildGroup(child, { graceMilliseconds: 50 });
      }
    }));
}
