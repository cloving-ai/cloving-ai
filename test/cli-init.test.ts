import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { withDoctor } from "./doctor-fixture.ts";

await test("CLV-209 init starts a file harness in the repository root and returns its exit status", () =>
  withDoctor(async (scene) => {
    const harness = await scene.program(
      "fake",
      `if (process.argv[2] === "--version") console.log("1.0.0");
else {
  const { writeFileSync } = await import("node:fs");
  writeFileSync("started.json", JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }));
  process.exit(7);
}`,
    );
    const directory = join(scene.repository, "nested");
    await mkdir(directory);
    const result = spawnSync(
      process.execPath,
      [resolve("src/cli.ts"), "init", "--harness", harness],
      { cwd: directory, env: scene.environment, encoding: "utf8" },
    );
    assert.equal(result.status, 7, result.stderr);
    assert.deepEqual(
      JSON.parse(
        await readFile(join(scene.repository, "started.json"), "utf8"),
      ),
      { cwd: scene.repository, args: ["run `cloving init-prompt`"] },
    );
    assert.equal(result.stderr, "");
  }));
