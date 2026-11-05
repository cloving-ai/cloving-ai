import assert from "node:assert/strict";
import { mkdir, symlink, truncate, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { runtimeDirectory } from "../src/cli/runtime-directory.ts";
import { check, withDoctor, type DoctorScene } from "./doctor-fixture.ts";

const day = 86_400_000;

function stateFolder(scene: DoctorScene): string {
  const runtime = runtimeDirectory(scene.environment, scene.repository);
  assert.ok(runtime);
  return dirname(runtime);
}

async function recordFolder(
  scene: DoctorScene,
  record: {
    readonly path: string;
    readonly bytes: number;
    readonly days: number;
  },
): Promise<void> {
  const folder = join(stateFolder(scene), record.path);
  await mkdir(folder, { recursive: true });
  const file = join(folder, "turn.jsonl");
  await writeFile(file, "");
  await truncate(file, record.bytes);
  const changed = new Date(Date.now() - record.days * day - 3_600_000);
  await utimes(file, changed, changed);
}

await test("CLV-271 doctor shows the size, folder count and oldest age of the kept records and the retention settings", () =>
  withDoctor(async (scene) => {
    for (const record of [
      { path: "journal/first", bytes: 1500, days: 12 },
      { path: "journal/second", bytes: 500, days: 2 },
      { path: "journal/runs", bytes: 100, days: 40 },
      { path: "github/effect", bytes: 300, days: 5 },
    ])
      await recordFolder(scene, record);
    await writeFile(join(stateFolder(scene), "github/index.json"), "{}");
    const shown = check(await scene.report(), "retention");
    assert.equal(shown["result"], "ok");
    assert.equal(shown["required"], false);
    assert.equal(
      shown["detail"],
      `journal 2.1 kB in 2 folders; github 302 bytes in 1 folder; workflow-bundles 0 bytes in 0 bundles; oldest kept folder 12 days old; retention.days 30, retention.action archive, retention.archiveFolder null (${join(stateFolder(scene), "archive")})`,
    );
    const configured = check(
      await scene.report({
        CLOVING_RETENTION_DAYS: "7",
        CLOVING_RETENTION_ACTION: "delete",
        CLOVING_RETENTION_ARCHIVE_FOLDER: "/records/archive",
      }),
      "retention",
    );
    assert.match(
      String(configured["detail"]),
      /; retention\.days 7, retention\.action delete, retention\.archiveFolder \/records\/archive$/,
    );
  }));

await test("CLV-271 doctor warns when retention.days is null and the records are larger than 1 GB", () =>
  withDoctor(async (scene) => {
    await recordFolder(scene, { path: "github/small", bytes: 10, days: 1 });
    const small = check(
      await scene.report({ CLOVING_RETENTION_DAYS: "null" }),
      "retention",
    );
    assert.equal(small["result"], "ok");
    await recordFolder(scene, {
      path: "journal/large",
      bytes: 1_000_000_000,
      days: 1,
    });
    const unlimited = await scene.report({ CLOVING_RETENTION_DAYS: "null" });
    const warned = check(unlimited, "retention");
    assert.equal(warned["result"], "warn");
    assert.match(
      String(warned["detail"]),
      /^journal 1\.0 GB in 1 folder; github 10 bytes in 1 folder; workflow-bundles 0 bytes in 0 bundles; .*; the records are larger than 1 GB and retention\.days is null$/,
    );
    assert.equal(
      warned["fix"],
      "Set a retention period: cloving config set retention.days 30 --private",
    );
    const limited = check(
      await scene.report({ CLOVING_RETENTION_DAYS: "30" }),
      "retention",
    );
    assert.equal(limited["result"], "ok");
    assert.doesNotMatch(String(limited["detail"]), /larger than 1 GB/);
  }));

await test("CLV-271 an invalid retention setting fails the optional doctor check and names the variable", () =>
  withDoctor(async (scene) => {
    const output = await scene.report({ CLOVING_RETENTION_ACTION: "move" });
    const failed = check(output, "retention");
    assert.equal(failed["result"], "fail");
    assert.equal(
      failed["detail"],
      "invalid-setting: CLOVING_RETENTION_ACTION must be archive or delete",
    );
  }));

await test("CLV-295 doctor shows the size and the count of the workflow bundles and counts them in the 1 GB warning", () =>
  withDoctor(async (scene) => {
    const store = join(stateFolder(scene), "workflow-bundles");
    await recordFolder(scene, { path: "journal/first", bytes: 100, days: 3 });
    for (const record of [
      { path: `workflow-bundles/${"a".repeat(64)}`, bytes: 2000, days: 400 },
      { path: `workflow-bundles/${"b".repeat(64)}`, bytes: 500, days: 1 },
      { path: "workflow-bundles/.history/x", bytes: 10, days: 1 },
      {
        path: `workflow-bundles/.removing-${"c".repeat(64)}`,
        bytes: 5,
        days: 1,
      },
    ])
      await recordFolder(scene, record);
    await symlink("..", join(store, "node_modules"));
    const shown = check(await scene.report(), "retention");
    assert.equal(shown["result"], "ok");
    assert.match(
      String(shown["detail"]),
      /^journal 100 bytes in 1 folder; github 0 bytes in 0 folders; workflow-bundles 2\.5 kB in 2 bundles; oldest kept folder 3 days old; /,
    );
    await recordFolder(scene, {
      path: `workflow-bundles/${"d".repeat(64)}`,
      bytes: 1_000_000_000,
      days: 1,
    });
    const warned = check(
      await scene.report({ CLOVING_RETENTION_DAYS: "null" }),
      "retention",
    );
    assert.equal(warned["result"], "warn");
    assert.match(
      String(warned["detail"]),
      /; workflow-bundles 1\.0 GB in 3 bundles; .*; the records are larger than 1 GB and retention\.days is null$/,
    );
  }));
