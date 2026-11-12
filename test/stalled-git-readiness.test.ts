import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { until } from "./claude-worker-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";
import { stalledGit } from "./self-host-processes-fixture.ts";

function silentWatcher(directory: string): string {
  return `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
fs.watch = () => {
  fs.writeFileSync(${JSON.stringify(join(directory, "watch-established"))}, "");
  return { close() {} };
};
process.kill = (pid, signal) => {
  const path = ${JSON.stringify(join(directory, "signal-sent"))};
  fs.writeFileSync(path + ".tmp", JSON.stringify({ pid, signal }));
  fs.renameSync(path + ".tmp", path);
  return true;
};
syncBuiltinESMExports();`;
}

await test("CLV-352 the stalled-git fixture observes completed readiness files when filesystem notifications are missed", () =>
  withFiles({}, async (directory) => {
    const preload = join(directory, "silent-watcher.mjs");
    const program = join(directory, "git.mjs");
    await writeFile(preload, silentWatcher(directory));
    await writeFile(
      program,
      stalledGit(directory, {
        repository: directory,
        command: "fetch",
        signal: "daemon",
      }),
    );
    await writeFile(join(directory, "daemon-ready"), "");
    await writeFile(join(directory, "watch-ready"), "");
    const child = spawn(
      process.execPath,
      ["--import", preload, program, "-C", directory, "fetch"],
      { stdio: "ignore" },
    );
    const closed = once(child, "close");
    try {
      await until(() => existsSync(join(directory, "watch-established")));
      assert.equal(existsSync(join(directory, "git-pid")), false);
      await writeFile(join(directory, "daemon-ready"), "1234");
      await writeFile(join(directory, "watch-ready"), "5678");
      await until(() => existsSync(join(directory, "signal-sent")));
      assert.deepEqual(
        JSON.parse(await readFile(join(directory, "signal-sent"), "utf8")),
        { pid: 1234, signal: "SIGTERM" },
      );
    } finally {
      child.kill("SIGKILL");
      await closed;
    }
  }));
