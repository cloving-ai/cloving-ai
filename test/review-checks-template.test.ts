import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { record } from "../src/protocol.ts";
import { isCandidateDeclaration } from "../src/workflow-candidate.ts";
import { loadWorkflowFolders } from "./candidate-package-fixture.ts";
import { folderInput } from "./workflow-folder-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";
import { cli } from "./cli-workflows-fixture.ts";
import { packagedEntry } from "./cli-templates-fixture.ts";
import {
  checksFiles,
  checksTemplate,
} from "./review-checks-template-fixture.ts";

await test("CLV-316 review-checks runs on Mondays at 07:00, reads two commands and hands off its own issue runs", async () => {
  const document = record(
    JSON.parse(await readFile(join(checksTemplate, "template.json"), "utf8")),
  );
  assert.equal(document?.["name"], "review-checks");
  assert.deepEqual(document["points"], []);
  const value: unknown = JSON.parse(
    await readFile(
      join(checksTemplate, "review-checks.declaration.json"),
      "utf8",
    ),
  );
  assert.ok(isCandidateDeclaration(value));
  assert.deepEqual(value.workflow.schedule, {
    at: "07:00",
    timeZone: "UTC",
    weekdays: ["monday"],
    input: {},
  });
  assert.deepEqual(value.workflow.commands, [
    "review-comments",
    "review-checks-record",
  ]);
  assert.deepEqual(value.workflow.handoffs, ["review-checks"]);
  assert.deepEqual(value.methods, {
    command: ["run:review-comments", "run:review-checks-record"],
    claude: ["run-turn"],
    github: ["prepare", "discard", "create-issue", "label"],
  });
});

await test("CLV-316 a copied review-checks admits and passes workflows test", async () => {
  await withFiles(await checksFiles(), async (directory) => {
    const loaded = await loadWorkflowFolders(folderInput(directory));
    assert.deepEqual(loaded.refusals, []);
    assert.deepEqual(
      loaded.candidates.map((candidate) => candidate.label),
      ["review-checks.ts"],
    );
    const result = cli(directory, {
      entry: packagedEntry,
      args: ["test", "review-checks"],
      environment: { NODE_TEST_CONTEXT: undefined },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /CLV-316/);
    assert.doesNotMatch(result.stdout, /not ok|✖/);
  });
});

await test("CLV-316 the static effect count of review-checks is 12", async () => {
  const files = await checksFiles();
  const key = "repo/.cloving/workflows/review-checks.declaration.json";
  files[key] = String(files[key]).replace(
    /"effectLimit": \d+/,
    '"effectLimit": 11',
  );
  await withFiles(files, async (directory) => {
    const loaded = await loadWorkflowFolders(folderInput(directory));
    assert.deepEqual(
      loaded.refusals.flatMap((refusal) => refusal.codes),
      ["effect-limit"],
    );
  });
});

await test("CLV-316 the review-checks README names the commands, the label, the rules and the effect count", async () => {
  const readme = await readFile(join(checksTemplate, "README.md"), "utf8");
  for (const requirement of [
    "private workflow folder",
    "CLOVING_COMMANDS",
    "review-comments.mts",
    "review-checks-record.mts",
    "GH_CONFIG_DIR",
    "Mondays at 07:00",
    "cloving: check",
    "at least 3",
    "at least 2 pull",
    "accept",
    "reject",
    "defer",
    '{"text": "<ticket>"}',
    "privateTexts",
    "The static effect count is 12",
  ])
    assert.ok(readme.includes(requirement), requirement);
});
