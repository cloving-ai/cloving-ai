import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { withFiles } from "./quality/files-fixture.ts";
import { stopChildGroup } from "./stop-child.ts";

const descendant = `
const timer = setInterval(() => {}, 1000);
process.once("SIGTERM", () => setImmediate(() => {
  clearInterval(timer);
  process.disconnect();
}));
process.send("ready");
`;

const launcher = `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], {
  stdio: ["ignore", "ignore", "inherit", "ipc"],
});
process.once("SIGTERM", () => child.kill("SIGTERM"));
child.once("message", () => console.log("ready"));
child.once("close", (code, signal) => {
  writeFileSync("descendant.json", JSON.stringify({ code, signal }));
});
`;

await test("CLV-201 group cleanup lets the launcher stop its covered descendants before signaling survivors", async () => {
  await withFiles({}, async (directory) => {
    const coverage = join(directory, "coverage");
    await mkdir(coverage);
    const child = spawn(process.execPath, ["-e", launcher], {
      cwd: directory,
      detached: true,
      env: { ...process.env, NODE_V8_COVERAGE: coverage },
      stdio: ["ignore", "pipe", "inherit"],
    });
    const descriptor = Object.getOwnPropertyDescriptor(process, "kill");
    assert.ok(descriptor);
    const kill = process.kill.bind(process);
    const premature: number[] = [];
    try {
      await once(child.stdout, "data");
      process.kill = (identifier, signal) => {
        if (
          identifier === -Number(child.pid) &&
          signal === "SIGTERM" &&
          child.exitCode === null &&
          child.signalCode === null
        )
          premature.push(identifier);
        return kill(identifier, signal);
      };
      await stopChildGroup(child);
      assert.deepEqual(premature, [], "the launcher owns graceful shutdown");
      assert.deepEqual(
        JSON.parse(await readFile(join(directory, "descendant.json"), "utf8")),
        { code: 0, signal: null },
      );
      const reports = await readdir(coverage);
      assert.equal(reports.length, 2);
      for (const file of reports)
        assert.ok(
          "result" in
            Object(JSON.parse(await readFile(join(coverage, file), "utf8"))),
        );
    } finally {
      Object.defineProperty(process, "kill", descriptor);
      await stopChildGroup(child);
    }
  });
});
