import assert from "node:assert/strict";
import { test } from "node:test";
import { withProject, workflowId } from "./cli-fixture.ts";

await test("CLV-006 workflows validate rejects malformed workflow input with a stable JSON error", async () => {
  await withProject(
    { "project with spaces/input.json": '{"cycleId":"has space"}' },
    (cli) => {
      const result = cli([
        "workflows",
        "validate",
        "cloving.workflow.json",
        "--input",
        "input.json",
        "--json",
      ]);
      assert.equal(result.status, 1);
      const output: unknown = JSON.parse(result.stdout);
      assert.deepEqual(output, {
        schemaVersion: 1,
        kind: "workflow-validation",
        status: "rejected",
        errors: [
          {
            code: "invalid-development-input",
            file: "input.json",
            detail: "cycleId",
          },
        ],
      });
    },
  );
});

await test("CLV-006 workflows validate reports the workflow and pinned identity for a valid compiled workflow", async () => {
  await withProject(
    { "project with spaces/input.json": '{"cycleId":"cycle-1"}' },
    (cli, directory) => {
      const result = cli([
        "workflows",
        "validate",
        `${directory}/cloving.workflow.json`,
        "--input",
        "input.json",
        "--json",
      ]);
      assert.equal(result.status, 0, result.stderr);
      const output: unknown = JSON.parse(result.stdout);
      assert.ok(output && typeof output === "object");
      const report = Object.fromEntries(Object.entries(output));
      assert.equal(report["status"], "valid");
      assert.deepEqual(report["workflow"], { name: "develop", workflowId });
      assert.match(String(report["pinnedIdentity"]), /^[0-9a-f]{64}$/);
      assert.deepEqual(report["errors"], []);
      const human = cli(["workflows", "validate", "cloving.workflow.json"]);
      assert.equal(human.status, 0, human.stderr);
      assert.match(human.stdout, /Workflow develop is valid/);
      assert.match(human.stdout, /Pinned identity: [0-9a-f]{64}/);
      assert.equal(human.stderr, "");
    },
  );
});

for (const [name, files, code] of [
  [
    "a missing compiled artifact",
    { "project with spaces/artifacts/steps.mjs": null },
    "missing-artifact",
  ],
  [
    "a malformed workflow manifest",
    { "project with spaces/cloving.workflow.json": "{" },
    "invalid-manifest",
  ],
  [
    "an unresolved helper step",
    {
      "project with spaces/artifacts/manifest.json": JSON.stringify({
        steps: {},
        workflows: { "workflows/develop.ts": { develop: { workflowId } } },
      }),
    },
    "unresolved-step",
  ],
  [
    "a missing prompt resource",
    { "project with spaces/prompts/implement.md": null },
    "inaccessible-resource",
  ],
] as const)
  await test(`CLV-006 workflows validate rejects ${name}`, async () => {
    await withProject(files, (cli) => {
      const result = cli([
        "workflows",
        "validate",
        "cloving.workflow.json",
        "--json",
      ]);
      assert.equal(result.status, 1, result.stderr);
      const output: unknown = JSON.parse(result.stdout);
      assert.match(JSON.stringify(output), new RegExp(`"code":"${code}"`));
      const human = cli(["workflows", "validate", "cloving.workflow.json"]);
      assert.equal(human.status, 1);
      assert.equal(human.stdout, "");
      assert.match(human.stderr, new RegExp(code));
    });
  });

await test("CLV-006 workflows validate rejects a project without the qualified SDK toolchain", async () => {
  await withProject(
    {
      "project with spaces/node_modules/workflow/package.json": null,
      "project with spaces/node_modules/@workflow/world-local/package.json":
        null,
      "project with spaces/node_modules/@workflow/core/package.json": null,
      "project with spaces/node_modules/@workflow/builders/package.json": null,
      "project with spaces/package-lock.json": null,
    },
    (cli) => {
      const result = cli([
        "workflows",
        "validate",
        "cloving.workflow.json",
        "--json",
      ]);
      assert.equal(result.status, 1);
      assert.match(result.stdout, /"code":"incompatible-toolchain"/);
    },
  );
});

for (const [name, files, argumentsList, code] of [
  [
    "an unreadable input file",
    { "project with spaces/input.json": "{" },
    ["--input", "input.json"],
    "unreadable-input",
  ],
  ["a missing input file", {}, ["--input", "missing.json"], "unreadable-input"],
  [
    "resources that are not a list",
    {
      "project with spaces/cloving.workflow.json": JSON.stringify({
        schemaVersion: 1,
        name: "develop",
        workflowId,
        steps: [],
        capabilities: [],
        resources: "prompts",
        artifacts: "artifacts",
      }),
    },
    [],
    "invalid-registration",
  ],
] as const)
  await test(`CLV-006 workflows validate reports ${name}`, async () => {
    await withProject(files, (cli) => {
      const result = cli([
        "workflows",
        "validate",
        "cloving.workflow.json",
        ...argumentsList,
        "--json",
      ]);
      assert.equal(result.status, 1);
      assert.match(result.stdout, new RegExp(`"code":"${code}"`));
    });
  });
