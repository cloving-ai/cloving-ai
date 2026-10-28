import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  templateTurnFiles,
  turnDeclaration,
  partialComposition,
} from "./develop-template-turn-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";
import { folderInput } from "./workflow-folder-fixture.ts";
import { testMilliseconds } from "./test-timing.ts";

export async function packedDevelopTurn(packageRoot: string): Promise<void> {
  await withFiles(
    {
      ...(await templateTurnFiles(join(packageRoot, "templates/develop"))),
      "repo/.cloving/workflows/develop.declaration.json":
        turnDeclaration("ticket"),
    },
    (directory) => {
      const loader = pathToFileURL(
        join(packageRoot, "dist/tools/workflow-folders.js"),
      ).href;
      const script = `import { writeFile } from "node:fs/promises";
import { loadWorkflowFolders } from ${JSON.stringify(loader)};
const results = [];
for (const declaration of ${JSON.stringify([turnDeclaration("ticket"), turnDeclaration("prompt")])}) {
  await writeFile(${JSON.stringify(join(directory, "repo/.cloving/workflows/develop.declaration.json"))}, declaration);
  const loaded = await loadWorkflowFolders(${JSON.stringify(folderInput(directory))});
  results.push({ candidates: loaded.candidates.length, refusals: loaded.refusals });
}
process.stdout.write(JSON.stringify(results));`;
      const loaded: unknown = JSON.parse(
        execFileSync(process.execPath, ["--input-type=module", "-e", script], {
          cwd: directory,
          encoding: "utf8",
          timeout: testMilliseconds(30000),
        }),
      );
      assert.deepEqual(loaded, [
        { candidates: 1, refusals: [] },
        { candidates: 1, refusals: [] },
      ]);
      packedPartialAdmission({ packageRoot, directory });
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

function packedPartialAdmission(input: {
  readonly packageRoot: string;
  readonly directory: string;
}): void {
  const { packageRoot, directory } = input;
  const loader = pathToFileURL(
    join(packageRoot, "dist/tools/workflow-folders.js"),
  ).href;
  const script = `import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadWorkflowFolders } from ${JSON.stringify(loader)};
const results = [];
for (const files of ${JSON.stringify([partialComposition("queue"), partialComposition("person")])}) {
  for (const [path, contents] of Object.entries(files))
    await writeFile(join(${JSON.stringify(directory)}, path), contents);
  const loaded = await loadWorkflowFolders(${JSON.stringify(folderInput(directory))});
  results.push({ candidates: loaded.candidates.length, refusals: loaded.refusals });
}
process.stdout.write(JSON.stringify(results));`;
  const loaded: unknown = JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: directory,
      encoding: "utf8",
      timeout: testMilliseconds(30000),
    }),
  );
  assert.deepEqual(loaded, [
    { candidates: 1, refusals: [] },
    { candidates: 1, refusals: [] },
  ]);
}
