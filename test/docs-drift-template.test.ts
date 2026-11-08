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
import { driftFiles, driftTemplate } from "./docs-drift-template-fixture.ts";

await test("CLV-317 docs-drift runs on Mondays at 07:00, reads docs-candidates, records with docs-drift-record and hands off to itself for each issue", async () => {
  const document = record(
    JSON.parse(await readFile(join(driftTemplate, "template.json"), "utf8")),
  );
  assert.deepEqual(Object.keys(document ?? {}).sort(), [
    "name",
    "points",
    "summary",
    "version",
  ]);
  assert.equal(document?.["name"], "docs-drift");
  assert.deepEqual(document["points"], []);
  const drift: unknown = JSON.parse(
    await readFile(join(driftTemplate, "docs-drift.declaration.json"), "utf8"),
  );
  assert.ok(isCandidateDeclaration(drift));
  assert.deepEqual(drift.workflow.schedule, {
    at: "07:00",
    timeZone: "UTC",
    weekdays: ["monday"],
    input: {},
  });
  assert.deepEqual(drift.workflow.commands, [
    "docs-candidates",
    "docs-drift-record",
  ]);
  assert.deepEqual(drift.workflow.handoffs, ["docs-drift"]);
  assert.deepEqual(drift.workflow.input.fields, {
    text: { type: "string", optional: true },
  });
  assert.equal(drift.workflow.effectLimit, 12);
  assert.deepEqual(drift.methods, {
    command: ["run:docs-candidates", "run:docs-drift-record"],
    claude: ["run-turn"],
    github: ["prepare", "discard", "create-issue", "label"],
  });
  const readme = await readFile(join(driftTemplate, "README.md"), "utf8");
  for (const requirement of [
    "private workflow folder",
    "CLOVING_COMMANDS",
    "CLOVING_SCHEDULES",
    "timeZone",
    "docs-candidates.mts",
    "docs-drift-record.mts",
    "cloving: docs",
    "at most 15 docs",
    "at most 5",
    '"codeCount"',
    "path:line",
    "privateTexts",
    "create-issue",
    '{"text": "<ticket>"}',
  ])
    assert.ok(readme.includes(requirement), requirement);
});

await test("CLV-317 a copied docs-drift admits and passes workflows test", async () => {
  await withFiles(await driftFiles(), async (directory) => {
    const loaded = await loadWorkflowFolders(folderInput(directory));
    assert.deepEqual(loaded.refusals, []);
    assert.deepEqual(
      loaded.candidates.map((candidate) => candidate.label),
      ["docs-drift.ts"],
    );
    const result = cli(directory, {
      entry: packagedEntry,
      args: ["test", "docs-drift"],
      environment: { NODE_TEST_CONTEXT: undefined },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /CLV-317/);
    assert.doesNotMatch(result.stdout, /not ok|✖/);
  });
});

await test("CLV-317 the static effect count of docs-drift is 12", async () => {
  const files = await driftFiles();
  const key = "repo/.cloving/workflows/docs-drift.declaration.json";
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
