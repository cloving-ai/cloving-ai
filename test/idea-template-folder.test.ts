import assert from "node:assert/strict";
import { test } from "node:test";
import { loadWorkflowFolders } from "./candidate-package-fixture.ts";
import { folderInput, operatorFiles } from "./workflow-folder-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";
import {
  configuredIdeaFiles,
  configurations,
  prefix,
} from "./idea-template-options-fixture.ts";
import { isCandidateDeclaration } from "../src/workflow-candidate.ts";

for (const selected of configurations)
  await test(`CLV-222 ${Object.values(selected).join("/")} admits with only its declared handoff targets`, async () => {
    const files = await configuredIdeaFiles(selected);
    if (selected.next === "develop")
      Object.assign(files, operatorFiles("project", "develop"));
    await withFiles(files, async (directory) => {
      const loaded = await loadWorkflowFolders(folderInput(directory));
      assert.deepEqual(loaded.refusals, []);
      const idea = loaded.candidates.find(
        (candidate) => candidate.label === "idea-to-issue.ts",
      );
      assert.ok(idea);
      const declaration: unknown = JSON.parse(idea.declaration);
      assert.ok(isCandidateDeclaration(declaration));
      assert.deepEqual(
        declaration.workflow.handoffs,
        selected.next === "develop" ? ["develop"] : [],
      );
      assert.equal(
        loaded.candidates.length,
        selected.next === "develop" ? 2 : 1,
      );
      assert.ok(files[prefix + "idea-to-issue.declaration.json"]);
    });
  });
