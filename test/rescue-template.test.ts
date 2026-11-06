import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { manifest } from "./develop-template-fixture.ts";
import { isCandidateDeclaration } from "../src/workflow-candidate.ts";
import { loadWorkflowFolders } from "./candidate-package-fixture.ts";
import { folderInput } from "./workflow-folder-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";
import { cli } from "./cli-workflows-fixture.ts";
import { packagedEntry } from "./cli-templates-fixture.ts";
import {
  configuredRescueFiles,
  rescueSelections,
} from "./rescue-template-options-fixture.ts";

await test("CLV-305 rescue-pr declares the accept and merge choices and a pull request input", async () => {
  const root = new URL("../templates/rescue-pr/", import.meta.url);
  const document = manifest(
    JSON.parse(await readFile(new URL("template.json", root), "utf8")),
  );
  assert.equal(document.name, "rescue-pr");
  assert.deepEqual(
    document.points.map((point) => [
      point.id,
      point.options.map((option) => option.id),
    ]),
    [
      ["accept", ["greptile", "person", "turn"]],
      ["merge", ["green", "person"]],
    ],
  );
  const declaration: unknown = JSON.parse(
    await readFile(new URL("rescue-pr.declaration.json", root), "utf8"),
  );
  assert.ok(isCandidateDeclaration(declaration));
  assert.deepEqual(declaration.workflow.input.fields, {
    pullRequest: { type: "integer", minimum: 1 },
    reason: { type: "string", optional: true },
    issue: { type: "string", optional: true },
    ticketStatus: { type: "string", optional: true },
  });
  assert.deepEqual(declaration.methods, {
    claude: ["run-turn"],
    github: ["prepare", "open-pr", "wait-review", "merge", "close-issue"],
  });
  const readme = await readFile(new URL("README.md", root), "utf8");
  for (const requirement of [
    "private workflow folder",
    "pullRequest",
    "Ticket status: complete",
    "cloving/",
    "prepare",
    "accept",
    "merge",
  ])
    assert.ok(readme.includes(requirement), requirement);
});

for (const selection of rescueSelections)
  await test(`CLV-305 copied rescue-pr with ${selection.accept}/${selection.merge} admits and passes workflows test`, async () => {
    const files = await configuredRescueFiles(selection);
    await withFiles(files, async (directory) => {
      const loaded = await loadWorkflowFolders(folderInput(directory));
      assert.deepEqual(loaded.refusals, []);
      const result = cli(directory, {
        entry: packagedEntry,
        args: ["test", "rescue-pr"],
        environment: { NODE_TEST_CONTEXT: undefined },
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /accepted review and green checks merges/);
      assert.doesNotMatch(result.stdout, /not ok|✖/);
    });
  });
