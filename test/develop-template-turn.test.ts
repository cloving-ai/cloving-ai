import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { loadWorkflowFolders } from "./candidate-package-fixture.ts";
import {
  templateTurnFiles,
  turnDeclaration,
} from "./develop-template-turn-fixture.ts";
import { folderInput } from "./workflow-folder-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";

const template = fileURLToPath(
  new URL("../templates/develop", import.meta.url),
);

for (const input of ["ticket", "prompt"] as const)
  await test(`CLV-221 the template turn helper passes folder admission with ${input} input`, async () => {
    await withFiles(
      {
        ...(await templateTurnFiles(template)),
        "repo/.cloving/workflows/develop.declaration.json":
          turnDeclaration(input),
      },
      async (directory) => {
        const loaded = await loadWorkflowFolders(folderInput(directory));
        assert.deepEqual(loaded.refusals, []);
        assert.equal(loaded.candidates.length, 1);
        const candidate = loaded.candidates[0];
        assert.ok(candidate);
        assert.equal(candidate.baseName, "develop");
        assert.deepEqual(Object.keys(candidate.helpers), ["develop/turn.ts"]);
      },
    );
  });
