import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { withFiles } from "./quality/files-fixture.ts";
import { folderInput, operatorFiles } from "./workflow-folder-fixture.ts";
import { validCandidateSource } from "./workflow-candidate-fixtures.ts";
import { testMilliseconds } from "./test-timing.ts";

export async function packedWorkflowFolders(root: string): Promise<void> {
  const files = {
    ...operatorFiles("project", "project"),
    "repo/.cloving/workflows/project.ts": `import { prompt } from "./project/prompts.ts";\n${validCandidateSource.replaceAll("candidate", "project").replace('payload: "synthetic"', "payload: prompt()")}`,
    "repo/.cloving/workflows/project/prompts.ts":
      'export function prompt() { return "packed-helper"; }',
    "repo/.cloving/workflows/project.test.ts": "ignored test source",
    ...operatorFiles("user", "user"),
    ...operatorFiles("user", "refused"),
    "config/cloving/workflows/refused.declaration.json": "{}",
  };
  await withFiles(files, async (directory) => {
    const installed = pathToFileURL(
      join(root, "node_modules/cloving/dist/tools/workflow-folders.js"),
    ).href;
    const output = execFileSync(
      process.execPath,
      [
        "--no-strip-types",
        "--input-type=module",
        "-e",
        `
import { loadWorkflowFolders } from ${JSON.stringify(installed)};
const result = await loadWorkflowFolders(${JSON.stringify(folderInput(directory))});
process.stdout.write(JSON.stringify({
  candidates: result.candidates.map(({ scope, label, repository }) => ({ scope, label, repository })),
  refusals: result.refusals,
}));
`,
      ],
      { cwd: root, encoding: "utf8", timeout: testMilliseconds(30000) },
    );
    const value: unknown = JSON.parse(output);
    assert.deepEqual(value, {
      candidates: [
        {
          scope: "project",
          label: "project.ts",
          repository: join(directory, "repo"),
        },
        {
          scope: "user",
          label: "user.ts",
          repository: join(directory, "repo"),
        },
      ],
      refusals: [
        { scope: "user", label: "refused.ts", codes: ["invalid-declaration"] },
      ],
    });
    for (const [name, bytes] of Object.entries(files))
      assert.equal(await readFile(join(directory, name), "utf8"), bytes);
  });
}
