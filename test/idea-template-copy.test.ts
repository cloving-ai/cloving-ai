import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { workflowTestLoader } from "../tools/workflow-test-loader.ts";
import { testMilliseconds } from "./test-timing.ts";
import { withFiles } from "./quality/files-fixture.ts";
import { manifest, configurationErrors } from "./develop-template-fixture.ts";
import {
  configuredIdeaFiles,
  configurations,
  prefix,
} from "./idea-template-options-fixture.ts";

await test("CLV-222 every option has a complete selection satisfying requires and passing the copied tests", async () => {
  const document = manifest(
    JSON.parse(
      await readFile(
        new URL("../templates/idea-to-issue/template.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  const covered = new Set<string>();
  for (const selected of configurations) {
    assert.deepEqual(configurationErrors(document, selected), []);
    for (const [point, option] of Object.entries(selected))
      covered.add(`${point}.${option}`);
    await withFiles(await configuredIdeaFiles(selected), (directory) => {
      const output = execFileSync(
        process.execPath,
        [
          "--import",
          workflowTestLoader(),
          "--test",
          join(directory, prefix, "idea-to-issue.test.ts"),
        ],
        {
          cwd: directory,
          encoding: "utf8",
          timeout: testMilliseconds(30000),
          env: { ...process.env, NODE_TEST_CONTEXT: undefined },
        },
      );
      assert.match(output, /selected complete configuration/);
      assert.doesNotMatch(output, /not ok|✖/);
    });
  }
  assert.deepEqual(
    [...covered].sort(),
    document.points
      .flatMap((point) =>
        point.options.map((option) => `${point.id}.${option.id}`),
      )
      .sort(),
  );
});
