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
  answerSelections,
  configuredAnswerFiles,
} from "./answer-review-options-fixture.ts";

await test("CLV-313 answer-review declares the resolve choice, a pull request input and the thread methods", async () => {
  const root = new URL("../templates/answer-review/", import.meta.url);
  const document = manifest(
    JSON.parse(await readFile(new URL("template.json", root), "utf8")),
  );
  assert.equal(document.name, "answer-review");
  assert.deepEqual(
    document.points.map((point) => [
      point.id,
      point.options.map((option) => [option.id, option.label]),
    ]),
    [
      [
        "resolve",
        [
          ["bot-fix", "Resolve bot threads after a fix"],
          ["never", "Never resolve"],
        ],
      ],
    ],
  );
  const declaration: unknown = JSON.parse(
    await readFile(new URL("answer-review.declaration.json", root), "utf8"),
  );
  assert.ok(isCandidateDeclaration(declaration));
  assert.deepEqual(declaration.workflow.input.fields, {
    pullRequest: { type: "integer", minimum: 1 },
  });
  assert.deepEqual(declaration.methods, {
    claude: ["run-turn"],
    github: [
      "prepare",
      "review-threads",
      "record-answered",
      "open-pr",
      "reply-thread",
      "resolve-thread",
      "wait-review",
    ],
  });
  const readme = await readFile(new URL("README.md", root), "utf8");
  for (const requirement of [
    "private workflow folder",
    "pullRequest",
    "review-threads",
    "reply-thread",
    "resolve-thread",
    "record-answered",
    "Thread T1: fixed",
    "Thread T1: no change",
    "Thread T1: question",
    "privacy",
    "patrol",
    "wait-review",
  ])
    assert.ok(readme.includes(requirement), requirement);
});

for (const selection of answerSelections)
  await test(`CLV-313 copied answer-review with resolve ${selection.resolve} admits and passes workflows test`, async () => {
    const files = await configuredAnswerFiles(selection);
    await withFiles(files, async (directory) => {
      const loaded = await loadWorkflowFolders(folderInput(directory));
      assert.deepEqual(loaded.refusals, []);
      const result = cli(directory, {
        entry: packagedEntry,
        args: ["test", "answer-review"],
        environment: { NODE_TEST_CONTEXT: undefined },
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /a fix of a bot thread posts one reply/);
      assert.doesNotMatch(result.stdout, /not ok|✖/);
    });
  });
