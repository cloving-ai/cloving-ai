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
      assert.ok(Array.isArray(loaded));
      assert.deepEqual(loaded, [
        { candidates: 1, refusals: [] },
        { candidates: 1, refusals: [] },
      ]);
      packedPartialAdmission({ packageRoot, directory });
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
  assert.ok(Array.isArray(loaded));
  assert.deepEqual(loaded, [
    { candidates: 1, refusals: [] },
    { candidates: 1, refusals: [] },
  ]);
}
