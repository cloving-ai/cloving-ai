import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { access, chmod, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { adoptionRecordPath } from "../src/cli/runtime-directory.ts";
import { retainWorkflowBundle } from "../tools/workflow-bundles.ts";
import { projectFiles } from "./cli-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";
import { check, withDoctor } from "./doctor-fixture.ts";

await test("CLV-207 doctor predicts legacy adoption without publishing a record", () =>
  withFiles(
    {
      ...projectFiles,
      "project with spaces/package.json": "{}",
      "project with spaces/declarations.json": "[]",
      "project with spaces/dependencies.json": "{}",
      "project with spaces/workflows/fixture.ts": "export const fixture = 1;",
    },
    (fixture) =>
      withDoctor(async (scene) => {
        await retainWorkflowBundle({
          project: join(fixture, "project with spaces"),
          repository: scene.repository,
          directory: join(scene.root, "state/cloving/workflow-bundles"),
        });
        const path = join(scene.root, "state/cloving/run");
        await mkdir(path, { mode: 0o755 });
        const item = check(await scene.report(), "runtime-directory");
        assert.equal(item["result"], "fail");
        assert.match(String(item["detail"]), /755/);
        const record = adoptionRecordPath(scene.environment, scene.repository);
        assert.ok(record);
        await assert.rejects(access(record), { code: "ENOENT" });
      }),
  ));

await test("CLV-207 non adoption startup ignores an unwritable state adoption folder", () =>
  withDoctor(async (scene) => {
    const state = join(scene.root, "state");
    await mkdir(state, { mode: 0o500 });
    const xdgRuntime = join(scene.root, "runtime");
    await mkdir(xdgRuntime);
    try {
      const item = check(
        await scene.report({ XDG_RUNTIME_DIR: xdgRuntime }),
        "runtime-directory",
      );
      assert.equal(item["result"], "ok", String(item["detail"]));
    } finally {
      await chmod(state, 0o700);
    }
  }));

await test("CLV-207 the read-only adoption adapter rejects incomplete selection inputs", () => {
  for (const argumentsList of [[], ["/unselected-runtime"]]) {
    const result = spawnSync(
      process.execPath,
      [resolve("tools/doctor-adoption.ts"), ...argumentsList],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  }
});
