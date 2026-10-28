import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { privateSettingsPath } from "../src/cli/project-settings.ts";
import { record } from "../src/protocol.ts";
import { cli } from "./cli-workflows-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";
import {
  operatorFiles,
  privateFolderFiles,
} from "./workflow-folder-fixture.ts";

async function privateFolderSetting(root: string): Promise<void> {
  const settings = privateSettingsPath(
    { HOME: root, XDG_CONFIG_HOME: join(root, "config") },
    join(root, "repo"),
  );
  await mkdir(dirname(settings), { recursive: true });
  await writeFile(
    settings,
    JSON.stringify({
      version: 1,
      workflows: { folder: join(root, "private/workflows") },
    }),
  );
}

function userRows(output: string): [string, string][] {
  const rows: unknown = JSON.parse(output);
  assert.ok(Array.isArray(rows));
  return rows
    .map((row) => record(row))
    .filter((row) => row?.["scope"] === "user")
    .map((row): [string, string] => {
      const id = row?.["workflowId"];
      const file = row?.["file"];
      assert.ok(typeof id === "string");
      assert.ok(typeof file === "string");
      return [id, file];
    });
}

await test("CLV-227 list reads the user folder from the private workflows.folder setting", () =>
  withFiles(
    {
      "repo/marker": "",
      "repo/nested/marker": "",
      ...operatorFiles("user", "home"),
      ...privateFolderFiles("own"),
    },
    async (root) => {
      await privateFolderSetting(root);
      spawnSync("git", ["init", "-q", join(root, "repo")]);
      for (const directory of [join(root, "repo"), join(root, "repo/nested")]) {
        const result = cli(root, { args: ["list", "--json"], directory });
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.deepEqual(userRows(result.stdout), [
          ["own", join(root, "private/workflows/own.ts")],
        ]);
      }
    },
  ));

await test("CLV-227 a relative CLOVING_WORKFLOW_FOLDER stops the workflows command", () =>
  withFiles({ "repo/marker": "" }, (root) => {
    const result = cli(root, {
      args: ["list", "--json"],
      environment: { CLOVING_WORKFLOW_FOLDER: "relative-workflows" },
    });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(
      result.stderr,
      /CLOVING_WORKFLOW_FOLDER must be an absolute path/,
    );
  }));
