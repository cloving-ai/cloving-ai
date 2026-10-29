import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { developFiles } from "./develop-template-flow-fixture.ts";
import { folderInput } from "./workflow-folder-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";
import { testMilliseconds } from "./test-timing.ts";
import {
  configuredDevelopFiles,
  completeConfigurations,
} from "./develop-template-options-fixture.ts";

export async function packedDevelopFlow(packageRoot: string): Promise<void> {
  const template = join(packageRoot, "templates/develop");
  await packedConfiguration(packageRoot, {
    files: await developFiles(template),
    expected: [
      /default workflow merges only a reviewed pull/,
      /partial work is queued only after/,
      /a check-failed fix receives the merge output/,
      /Greptile below 5\/5 cannot merge/,
    ],
  });
  for (const selected of completeConfigurations)
    await packedConfiguration(packageRoot, {
      files: await configuredDevelopFiles(template, selected),
      expected: [/selected complete configuration/, /selected partial policy/],
    });
}

async function packedConfiguration(
  packageRoot: string,
  configuration: {
    readonly files: Readonly<Record<string, string>>;
    readonly expected: readonly RegExp[];
  },
): Promise<void> {
  await withFiles(configuration.files, (directory) => {
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
    for (const expected of configuration.expected)
      assert.match(output, expected);
    assert.match(output, /template develops a ticket/);
    assert.match(output, /task text reaches the development turn/);
    assert.match(output, /fix turn receives the full check-failed output/);
    assert.match(output, /partial questions use distinct rounds/);
    assert.match(output, /queued partial work records the merged pull request/);
    assert.doesNotMatch(output, /not ok|✖/);
  });
}
