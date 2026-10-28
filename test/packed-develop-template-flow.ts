import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { developFiles } from "./develop-template-flow-fixture.ts";
import { folderInput } from "./workflow-folder-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";
import { testMilliseconds } from "./test-timing.ts";

export async function packedDevelopFlow(packageRoot: string): Promise<void> {
  await withFiles(
    await developFiles(join(packageRoot, "templates/develop")),
    (directory) => {
      const loader = pathToFileURL(
        join(packageRoot, "dist/tools/workflow-folders.js"),
      ).href;
      const script = `import { loadWorkflowFolders } from ${JSON.stringify(loader)};
const loaded = await loadWorkflowFolders(${JSON.stringify(folderInput(directory))});
process.stdout.write(JSON.stringify({ candidates: loaded.candidates.length, refusals: loaded.refusals }));`;
      const loaded: unknown = JSON.parse(
        execFileSync(process.execPath, ["--input-type=module", "-e", script], {
          cwd: directory,
          encoding: "utf8",
          timeout: testMilliseconds(30000),
        }),
      );
      assert.deepEqual(loaded, { candidates: 1, refusals: [] });
      const output = execFileSync(
        process.execPath,
        [join(packageRoot, "dist/src/cli.js"), "workflows", "test"],
        {
          cwd: join(directory, "repo"),
          env: {
            ...process.env,
            NODE_TEST_CONTEXT: undefined,
            XDG_CONFIG_HOME: join(directory, "config"),
          },
          encoding: "utf8",
          timeout: testMilliseconds(30000),
        },
      );
      assert.match(output, /default workflow merges only a reviewed pull/);
      assert.match(output, /partial work is queued only after/);
      assert.match(output, /a check-failed fix receives the merge output/);
      assert.match(output, /Greptile below 5\/5 cannot merge/);
      assert.match(output, /template develops a ticket/);
      assert.match(output, /task text reaches the development turn/);
      assert.match(output, /fix turn receives the full check-failed output/);
      assert.match(output, /partial questions use distinct rounds/);
      assert.match(
        output,
        /queued partial work records the merged pull request/,
      );
      assert.doesNotMatch(output, /not ok|✖/);
    },
  );
}
