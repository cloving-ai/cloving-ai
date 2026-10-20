import assert from "node:assert/strict";
import { mkdir, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { loadWorkflowFolders } from "./candidate-package-fixture.ts";
import { folderInput, operatorFiles } from "./workflow-folder-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";

for (const scope of ["project", "user"] as const) {
  for (const part of ["ancestor", "folder", "source", "declaration"] as const) {
    await test(`CLV-124 refuses linked ${scope} ${part} without losing valid neighbors`, () =>
      withFiles(
        {
          ...operatorFiles("project", "project"),
          ...operatorFiles("user", "user"),
        },
        async (directory) => {
          const base = scope === "project" ? "repo/.cloving" : "config/cloving";
          const names = {
            ancestor: base,
            folder: `${base}/workflows`,
            source: `${base}/workflows/${scope}.ts`,
            declaration: `${base}/workflows/${scope}.declaration.json`,
          };
          const path = join(directory, names[part]);
          await rename(path, path + ".saved");
          await symlink(path + ".saved", path);
          const result = await loadWorkflowFolders(folderInput(directory));
          assert.deepEqual(result.refusals, [
            {
              scope,
              label:
                part === "ancestor" || part === "folder"
                  ? "workflows/"
                  : `${scope}.ts`,
              codes: ["unsafe-workflow-path"],
            },
          ]);
          assert.deepEqual(
            result.candidates.map((entry) => entry.scope),
            [scope === "project" ? "user" : "project"],
          );
        },
      ));
  }
}

await test("CLV-124 missing folders are empty and never created", () =>
  withFiles({ "repo/marker": "" }, async (directory) => {
    const result = await loadWorkflowFolders(folderInput(directory));
    assert.deepEqual(result, {
      repository: join(directory, "repo"),
      candidates: [],
      refusals: [],
    });
  }));

for (const setting of [undefined, "", "relative"]) {
  await test(`CLV-124 configuration setting ${String(setting)} uses the home configuration root`, () =>
    withFiles(
      { "repo/marker": "", ...operatorFiles("user", "user") },
      async (directory) => {
        await rename(join(directory, "config"), join(directory, ".config"));
        const input = folderInput(directory);
        const result = await loadWorkflowFolders({
          ...input,
          xdgConfigHome: setting,
        });
        assert.deepEqual(
          result.candidates.map((entry) => entry.scope),
          ["user"],
        );
        assert.deepEqual(result.refusals, []);
      },
    ));
}

await test("CLV-124 canonicalizes the served repository before binding candidates", () =>
  withFiles(operatorFiles("project", "project"), async (directory) => {
    await symlink(join(directory, "repo"), join(directory, "alias"));
    const result = await loadWorkflowFolders({
      ...folderInput(directory),
      repository: join(directory, "alias"),
    });
    assert.equal(result.repository, join(directory, "repo"));
    assert.equal(result.candidates[0]?.repository, result.repository);
  }));

await test("CLV-124 reports unreadable folder entries and missing declarations independently", () =>
  withFiles(
    {
      ...operatorFiles("project", "project"),
      "repo/.cloving/workflows/missing.ts": "source-sentinel",
      "config/cloving": "not a folder",
    },
    async (directory) => {
      const result = await loadWorkflowFolders(folderInput(directory));
      assert.deepEqual(
        result.candidates.map((entry) => entry.label),
        ["project.ts"],
      );
      assert.deepEqual(result.refusals, [
        {
          scope: "project",
          label: "missing.ts",
          codes: ["workflow-read-failed"],
        },
        { scope: "user", label: "workflows/", codes: ["workflow-read-failed"] },
      ]);
      assert.equal(
        JSON.stringify(result.refusals).includes("source-sentinel"),
        false,
      );
    },
  ));

await test("CLV-124 scans only direct TypeScript candidates and refuses special entries", () =>
  withFiles(
    {
      ...operatorFiles("project", "project"),
      "repo/.cloving/workflows/ignored.d.ts": "",
      "repo/.cloving/workflows/ignored.js": "",
      "repo/.cloving/workflows/nested/hidden.ts": "",
    },
    async (directory) => {
      await mkdir(join(directory, "repo/.cloving/workflows/directory.ts"));
      await writeFile(
        join(directory, "repo/.cloving/workflows/other.json"),
        "{}",
      );
      const result = await loadWorkflowFolders(folderInput(directory));
      assert.deepEqual(
        result.candidates.map((entry) => entry.label),
        ["project.ts"],
      );
      assert.deepEqual(result.refusals, [
        {
          scope: "project",
          label: "directory.ts",
          codes: ["unsafe-workflow-path"],
        },
      ]);
    },
  ));
