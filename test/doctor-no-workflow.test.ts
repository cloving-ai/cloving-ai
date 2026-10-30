import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { check, settings, withDoctor } from "./doctor-fixture.ts";
import { operatorFiles } from "./workflow-folder-fixture.ts";

await test("CLV-228 doctor fails a required no-workflow check without project or user workflows", () =>
  withDoctor(async (scene) => {
    const output = await scene.report();
    const item = check(output, "no-workflow");
    assert.equal(item["result"], "fail");
    assert.equal(item["required"], true);
    assert.equal(item["fix"], "cloving init");
    assert.equal(output.status, 1);
  }));

for (const scope of ["project", "user"] as const)
  await test(`CLV-228 doctor accepts a ${scope} declaration without executing its workflow`, () =>
    withDoctor(async (scene) => {
      for (const [name, text] of Object.entries(
        operatorFiles(scope, "custom"),
      )) {
        const file = join(scene.root, name.replace("repo/", "repository/"));
        await mkdir(dirname(file), { recursive: true });
        await writeFile(
          file,
          file.endsWith(".ts") ? 'throw new Error("must not execute")' : text,
        );
      }
      const output = await scene.report();
      assert.equal(check(output, "no-workflow")["result"], "ok");
      assert.equal(output.status, 0);
    }));

await test("CLV-228 no-workflow stays unresolved when settings or discovery are unavailable", () =>
  withDoctor(async (scene) => {
    await settings(scene, { version: 7 });
    const invalid = check(await scene.report(), "no-workflow");
    assert.equal(invalid["required"], true);
    assert.equal(invalid["result"], "skip");
    assert.match(String(invalid["detail"]), /Settings files are invalid/);
    await settings(scene, { version: 1 });
    await writeFile(
      join(scene.repository, ".cloving/workflows"),
      "not a folder",
    );
    const unavailable = await scene.report();
    assert.equal(check(unavailable, "no-workflow")["result"], "skip");
    assert.match(
      String(check(unavailable, "no-workflow")["detail"]),
      /Workflow requirements unavailable/,
    );
    assert.equal(unavailable.status, 1);
  }));

await test("CLV-228 copying a template resolves no-workflow on the next doctor check", () =>
  withDoctor(async (scene) => {
    assert.equal(check(await scene.report(), "no-workflow")["result"], "fail");
    const copied = spawnSync(
      process.execPath,
      [resolve("src/cli.ts"), "templates", "copy", "develop"],
      { cwd: scene.repository, env: scene.environment, encoding: "utf8" },
    );
    assert.equal(copied.status, 0, copied.stdout + copied.stderr);
    const output = await scene.report();
    assert.equal(check(output, "no-workflow")["result"], "ok");
    assert.equal(output.status, 0);
  }));
