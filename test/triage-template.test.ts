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
  configuredTriageFiles,
  triageSelections,
} from "./triage-template-fixture.ts";

await test("CLV-319 triage-issue declares the post choice, a 30 minute schedule and its own handoff", async () => {
  const root = new URL("../templates/triage-issue/", import.meta.url);
  const document = manifest(
    JSON.parse(await readFile(new URL("template.json", root), "utf8")),
  );
  assert.equal(document.name, "triage-issue");
  assert.deepEqual(
    document.points.map((point) => [
      point.id,
      point.options.map((option) => [option.id, option.label]),
    ]),
    [
      [
        "post",
        [
          ["person", "A person approves"],
          ["now", "Post at once"],
        ],
      ],
    ],
  );
  const declaration: unknown = JSON.parse(
    await readFile(new URL("triage-issue.declaration.json", root), "utf8"),
  );
  assert.ok(isCandidateDeclaration(declaration));
  assert.deepEqual(declaration.workflow.schedule, {
    everySeconds: 1800,
    input: {},
  });
  assert.deepEqual(declaration.workflow.commands, ["triage-candidates"]);
  assert.deepEqual(declaration.workflow.handoffs, ["triage-issue"]);
  assert.deepEqual(declaration.methods, {
    command: ["run:triage-candidates"],
    claude: ["run-turn"],
    github: ["prepare", "comment-issue", "label", "discard"],
  });
  const readme = await readFile(new URL("README.md", root), "utf8");
  for (const requirement of [
    "private workflow folder",
    "CLOVING_COMMANDS",
    "triage-candidates",
    "triage-candidates.mts",
    '"number"',
    "cloving: triaged",
    "Triage: duplicate #<number>",
    "Triage: bug <size>",
    "Triage: feature <size>",
    "Triage: needs-information",
    "comment-issue",
    "privateTexts",
    "four",
    "1800",
    "never closes",
  ])
    assert.ok(readme.includes(requirement), requirement);
});

for (const selection of triageSelections)
  await test(`CLV-319 copied triage-issue with post ${selection.post} admits and passes workflows test`, async () => {
    await withFiles(
      await configuredTriageFiles(selection),
      async (directory) => {
        const loaded = await loadWorkflowFolders(folderInput(directory));
        assert.deepEqual(loaded.refusals, []);
        assert.deepEqual(
          loaded.candidates.map((candidate) => candidate.label),
          ["triage-issue.ts"],
        );
        const result = cli(directory, {
          entry: packagedEntry,
          args: ["test", "triage-issue"],
          environment: { NODE_TEST_CONTEXT: undefined },
        });
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /four of six candidates/);
        assert.doesNotMatch(result.stdout, /not ok|✖/);
      },
    );
  });
