import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadWorkflowFolders } from "./candidate-package-fixture.ts";
import { folderInput } from "./workflow-folder-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";

import { developFiles } from "./develop-template-flow-fixture.ts";
import { isCandidateDeclaration } from "../src/workflow-candidate.ts";

await test("CLV-221 the executable default passes folder admission", async () => {
  const template = fileURLToPath(
    new URL("../templates/develop", import.meta.url),
  );
  await withFiles(await developFiles(template), async (directory) => {
    const loaded = await loadWorkflowFolders(folderInput(directory));
    assert.deepEqual(loaded.refusals, []);
    assert.equal(loaded.candidates.length, 1);
    const declaration: unknown = JSON.parse(
      loaded.candidates[0]?.declaration ?? "null",
    );
    assert.ok(isCandidateDeclaration(declaration));
    assert.equal(declaration.workflow.queue, true);
  });
});
