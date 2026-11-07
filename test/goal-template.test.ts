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
import { selected } from "./rescue-template-options-fixture.ts";
import {
  configuredGoalFiles,
  goalSelections,
} from "./goal-template-fixture.ts";

const root = new URL("../templates/goal-to-tickets/", import.meta.url);

await test("CLV-302 goal-to-tickets declares the review and next choices with the hands-off defaults first", async () => {
  const document = manifest(
    JSON.parse(await readFile(new URL("template.json", root), "utf8")),
  );
  assert.equal(document.name, "goal-to-tickets");
  assert.deepEqual(
    document.points.map((point) => [
      point.id,
      point.options.map((option) => [option.id, option.label]),
    ]),
    [
      [
        "review",
        [
          ["turn", "A review turn corrects the plan"],
          ["person", "I read the plan"],
        ],
      ],
      [
        "next",
        [
          ["queue", "Put the ready tickets in the queue"],
          ["develop", "Hand the first ready ticket to develop"],
          ["nothing", "Do nothing"],
        ],
      ],
    ],
  );
  const declaration: unknown = JSON.parse(
    await readFile(new URL("goal-to-tickets.declaration.json", root), "utf8"),
  );
  assert.ok(isCandidateDeclaration(declaration));
  assert.equal(declaration.workflow.effectLimit, 32);
  assert.deepEqual(declaration.workflow.input, {
    maximumBytes: 32768,
    fields: { goal: { type: "string" } },
  });
  assert.deepEqual(declaration.methods, {
    claude: ["run-turn"],
    github: ["prepare", "capture-draft", "create-issue", "label", "discard"],
  });
});

await test("CLV-302 the goal-to-tickets README names the plan format, the cycle rule and the post rules", async () => {
  const readme = await readFile(new URL("README.md", root), "utf8");
  for (const requirement of [
    "cloving templates copy goal-to-tickets",
    '"goal"',
    "32768",
    "cloving-goal-plan.md",
    "# Draft N: <title>",
    "Needs draft N",
    "Needs #<number>",
    "plan-cycle",
    "invalid-plan",
    "plan-not-approved",
    "create-issue",
    "privateTexts",
    "cloving: ready",
    "effectLimit",
  ])
    assert.ok(readme.includes(requirement), requirement);
});

for (const selection of goalSelections)
  await test(`CLV-302 copied goal-to-tickets with ${selection.review}/${selection.next} admits and passes workflows test`, async () => {
    await withFiles(await configuredGoalFiles(selection), async (directory) => {
      const loaded = await loadWorkflowFolders(folderInput(directory));
      assert.deepEqual(loaded.refusals, []);
      assert.deepEqual(
        loaded.candidates.map((candidate) => candidate.label),
        ["goal-to-tickets.ts"],
      );
      const result = cli(directory, {
        entry: packagedEntry,
        args: ["test", "goal-to-tickets"],
        environment: { NODE_TEST_CONTEXT: undefined },
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /12 tickets after one cycle/);
      assert.doesNotMatch(result.stdout, /not ok|✖/);
    });
  });

for (const selection of [
  { review: "person", next: "queue" },
  { review: "turn", next: "nothing" },
])
  await test(`CLV-302 a copy with the default imports and the ${selection.review}/${selection.next} selection fails workflows test`, async () => {
    const files = await configuredGoalFiles({ review: "turn", next: "queue" });
    selected(files, { path: "goal-to-tickets/scenarios.ts", selection });
    await withFiles(files, (directory) => {
      const result = cli(directory, {
        entry: packagedEntry,
        args: ["test", "goal-to-tickets"],
        environment: { NODE_TEST_CONTEXT: undefined },
      });
      assert.notEqual(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /✖ CLV-302 the selected options give/);
    });
  });
