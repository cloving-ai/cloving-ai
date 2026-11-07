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
  auditFiles,
  auditTemplate,
  ticketTemplate,
} from "./dependency-audit-template-fixture.ts";

async function declaration(folder: string, name: string) {
  const value: unknown = JSON.parse(
    await readFile(join(folder, `${name}.declaration.json`), "utf8"),
  );
  assert.ok(isCandidateDeclaration(value));
  return value;
}

await test("CLV-318 dependency-audit runs each day, reads audit-candidates and hands off to dependency-ticket", async () => {
  for (const [folder, name] of [
    [auditTemplate, "dependency-audit"],
    [ticketTemplate, "dependency-ticket"],
  ] as const) {
    const document = record(
      JSON.parse(await readFile(join(folder, "template.json"), "utf8")),
    );
    assert.deepEqual(Object.keys(document ?? {}).sort(), [
      "name",
      "points",
      "summary",
      "version",
    ]);
    assert.equal(document?.["name"], name);
    assert.deepEqual(document["points"], []);
  }
  const audit = await declaration(auditTemplate, "dependency-audit");
  assert.deepEqual(audit.workflow.schedule, { everySeconds: 86400, input: {} });
  assert.deepEqual(audit.workflow.commands, ["audit-candidates"]);
  assert.deepEqual(audit.workflow.handoffs, ["dependency-ticket"]);
  assert.equal(audit.workflow.effectLimit, 9);
  assert.deepEqual(audit.methods, {
    command: ["run:audit-candidates"],
    claude: ["run-turn"],
    github: ["prepare", "discard"],
  });
  const ticket = await declaration(ticketTemplate, "dependency-ticket");
  assert.deepEqual(ticket.methods, { github: ["create-issue", "label"] });
  assert.deepEqual(ticket.workflow.input.fields, { text: { type: "string" } });
  assert.equal(ticket.workflow.effectLimit, 2);
  const readme = await readFile(join(auditTemplate, "README.md"), "utf8");
  for (const requirement of [
    "private workflow folder",
    "CLOVING_COMMANDS",
    "CLOVING_COMMAND_SECONDS",
    "audit-candidates.mts",
    "npm ci --ignore-scripts",
    "npm audit --json",
    "npm ls --all --json",
    "cloving: security",
    "86400",
    "at most 10 packages",
    "at most 5 groups",
    '"patchedRange"',
    '"paths"',
    "same exact pin",
    "scripts disabled",
    "dependency-ticket",
  ])
    assert.ok(readme.includes(requirement), requirement);
  const child = await readFile(join(ticketTemplate, "README.md"), "utf8");
  for (const requirement of [
    "create-issue",
    "cloving: security",
    "privateTexts",
  ])
    assert.ok(child.includes(requirement), requirement);
});

await test("CLV-318 copied dependency-audit and dependency-ticket admit and pass workflows test", async () => {
  await withFiles(await auditFiles(), async (directory) => {
    const loaded = await loadWorkflowFolders(folderInput(directory));
    assert.deepEqual(loaded.refusals, []);
    assert.deepEqual(
      loaded.candidates.map((candidate) => candidate.label).sort(),
      ["dependency-audit.ts", "dependency-ticket.ts"],
    );
    for (const name of ["dependency-audit", "dependency-ticket"]) {
      const result = cli(directory, {
        entry: packagedEntry,
        args: ["test", name],
        environment: { NODE_TEST_CONTEXT: undefined },
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /CLV-318/);
      assert.doesNotMatch(result.stdout, /not ok|✖/);
    }
  });
});

await test("CLV-318 the static effect counts are 9 for the audit and 2 for the ticket run", async () => {
  for (const [name, limit] of [
    ["dependency-audit", 8],
    ["dependency-ticket", 1],
  ] as const) {
    const files = await auditFiles();
    const key = `repo/.cloving/workflows/${name}.declaration.json`;
    files[key] = String(files[key]).replace(
      /"effectLimit": \d+/,
      `"effectLimit": ${String(limit)}`,
    );
    await withFiles(files, async (directory) => {
      const loaded = await loadWorkflowFolders(folderInput(directory));
      assert.deepEqual(
        loaded.refusals.flatMap((refusal) => refusal.codes),
        ["effect-limit"],
      );
    });
  }
});
