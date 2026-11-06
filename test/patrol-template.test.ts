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
import { configuredAnswerFiles } from "./answer-review-options-fixture.ts";
import {
  configuredPatrolFiles,
  configuredRescueFiles,
  patrolSelections,
} from "./rescue-template-options-fixture.ts";

const readmeRequirements = [
  "private workflow folder",
  "CLOVING_COMMANDS",
  "patrol-status",
  '"number"',
  '"branch"',
  '"state"',
  '"active"',
  '"reason"',
  '"head"',
  '"score"',
  '"issue"',
  '"ticketStatus"',
  "rescue-pr",
  "four",
  "1800",
  "answer-review",
  "review-threads",
  "5 minutes",
  "record-answered",
  "eight",
];

await test("CLV-305 patrol declares the act choice, a 30 minute schedule and the rescue-pr and answer-review handoffs", async () => {
  const root = new URL("../templates/patrol/", import.meta.url);
  const document = manifest(
    JSON.parse(await readFile(new URL("template.json", root), "utf8")),
  );
  assert.equal(document.name, "patrol");
  assert.deepEqual(
    document.points.map((point) => [
      point.id,
      point.options.map((option) => [option.id, option.label]),
    ]),
    [
      [
        "act",
        [
          ["ask", "Ask a person first"],
          ["now", "Hand off at once"],
        ],
      ],
    ],
  );
  const declaration: unknown = JSON.parse(
    await readFile(new URL("patrol.declaration.json", root), "utf8"),
  );
  assert.ok(isCandidateDeclaration(declaration));
  assert.deepEqual(declaration.workflow.schedule, {
    everySeconds: 1800,
    input: {},
  });
  assert.deepEqual(declaration.workflow.commands, ["patrol-status"]);
  assert.deepEqual(declaration.workflow.capabilities, ["command", "github"]);
  assert.deepEqual(declaration.workflow.handoffs, [
    "rescue-pr",
    "answer-review",
  ]);
  assert.deepEqual(declaration.methods, {
    command: ["run:patrol-status"],
    github: ["review-threads"],
  });
  const readme = await readFile(new URL("README.md", root), "utf8");
  for (const requirement of readmeRequirements)
    assert.ok(readme.includes(requirement), requirement);
});

for (const selection of patrolSelections)
  await test(`CLV-305 copied patrol with act ${selection.act} admits and passes workflows test`, async () => {
    const files = Object.assign(
      await configuredPatrolFiles(selection),
      await configuredRescueFiles({ accept: "greptile", merge: "green" }),
      await configuredAnswerFiles({ resolve: "bot-fix" }),
    );
    await withFiles(files, async (directory) => {
      const loaded = await loadWorkflowFolders(folderInput(directory));
      assert.deepEqual(loaded.refusals, []);
      assert.deepEqual(
        loaded.candidates.map((candidate) => candidate.label).sort(),
        ["answer-review.ts", "patrol.ts", "rescue-pr.ts"],
      );
      const result = cli(directory, {
        entry: packagedEntry,
        args: ["test", "patrol"],
        environment: { NODE_TEST_CONTEXT: undefined },
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /four of six candidates/);
      assert.doesNotMatch(result.stdout, /not ok|✖/);
    });
  });
