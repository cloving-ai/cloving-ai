import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  promptResolver,
  ticketRegistrations,
  ticketRegistrationTable,
} from "../src/daemon/ticket-registration.ts";
import { withProject, workflowId } from "./cli-fixture.ts";

const functions = [
  { name: "develop", functionName: "develop", workflowId, effectLimit: 8 },
  {
    name: "other",
    functionName: "developOther",
    workflowId: "workflow//./workflows/other//developOther",
    effectLimit: 16,
  },
];

const declared = {
  workflowId: "review-run",
  functionName: "developOther",
  effectLimit: 14,
  capabilities: ["claude"],
  input: {
    maximumBytes: 65_536,
    fields: { rounds: { type: "integer", minimum: 1, maximum: 10 } },
  },
} as const;

await test("CLV-089 a declared workflow registers its manifest, effect limit and capabilities", async () => {
  await withProject({}, async (_cli, directory) => {
    const manifests = await manifestsIn(directory);
    const path = join(directory, "other.workflow.json");
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        name: "other",
        workflowId: functions[1]?.workflowId,
        steps: [],
        capabilities: ["claude"],
        resources: [],
        artifacts: "artifacts",
      }),
    );
    const table = ticketRegistrationTable(
      { repository: directory, command: undefined },
      [declared],
    );
    assert.deepEqual(
      table.slice(0, 4).map((row) => row.workflowId),
      ["develop-ticket", "develop-issue", "develop-prd", "develop-prompt"],
    );
    const row = table.find((entry) => entry.workflowId === "review-run");
    assert.ok(row);
    const result = await ticketRegistrations(manifests, { table: [row] });
    assert.equal(result.kind, "admitted");
    const registration = result.registrations[0];
    assert.ok(registration);
    assert.equal(registration.effectLimit, 14);
    assert.equal(registration.manifest.workflowId, functions[1]?.workflowId);
    assert.deepEqual(registration.manifest.capabilities, ["claude"]);
    assert.deepEqual(registration.submission, declared.input);
    assert.deepEqual(
      await registration.resolver.resolve({
        workflowId: "review-run",
        commandId: "command-1",
        submission: { rounds: 3 },
        signal: new AbortController().signal,
      }),
      {
        kind: "resolved",
        input: {
          cycleId: "task-e12c157c0051",
          repository: directory,
          input: { rounds: 3 },
        },
      },
    );
  });
});

await test("CLV-089 duplicate declared IDs cannot shadow built-in or declared registrations", async () => {
  for (const declarations of [
    [{ ...declared, workflowId: "develop-ticket" }],
    [declared, declared],
  ]) {
    const table = ticketRegistrationTable(
      { repository: "/repositories/example", command: undefined },
      declarations,
    );
    const result = await ticketRegistrations({}, { table });
    assert.equal(result.kind, "rejected");
    assert.match(result.detail, /duplicate-workflow-id/);
  }
});

await test("CLV-081 develop-issue admits preparation, four complete rounds and labels with 20 effects", () => {
  const row = ticketRegistrationTable({
    repository: "/repositories/example",
    command: undefined,
  }).find((entry) => entry.workflowId === "develop-issue");
  assert.equal(row?.effectLimit, 20);
});

async function manifestsIn(directory: string): Promise<Record<string, string>> {
  await writeFile(
    join(directory, "artifacts/manifest.json"),
    JSON.stringify({
      steps: {},
      workflows: Object.fromEntries(
        functions.map((entry) => [
          `workflows/${entry.name}.ts`,
          { [entry.functionName]: { workflowId: entry.workflowId } },
        ]),
      ),
    }),
  );
  const manifests: Record<string, string> = {};
  for (const { name, functionName, workflowId } of functions) {
    const path = join(directory, `${name}.workflow.json`);
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        name,
        workflowId,
        steps: [],
        capabilities: ["claude", "github"],
        resources: [],
        artifacts: "artifacts",
      }),
    );
    manifests[functionName] = path;
  }
  return manifests;
}

await test("CLV-074 registrations admit the manifest of each row's workflow function", async () => {
  await withProject({}, async (_cli, directory) => {
    const manifests = await manifestsIn(directory);
    const table = functions.map((entry) => ({
      workflowId: `run-${entry.name}`,
      functionName: entry.functionName,
      effectLimit: entry.effectLimit,
      submission: {
        maximumBytes: 65_536,
        fields: { prompt: "string" as const },
      },
      resolver: promptResolver(directory),
    }));
    const admitted = await ticketRegistrations(manifests, { table });
    assert.equal(admitted.kind, "admitted", JSON.stringify(admitted));
    assert.deepEqual(
      admitted.registrations.map((entry) => ({
        workflowId: entry.workflowId,
        name: entry.manifest.name,
        compiledId: entry.manifest.workflowId,
        effectLimit: entry.effectLimit,
        submission: entry.submission,
        resolver: entry.resolver,
        availability: entry.availability,
      })),
      functions.map((entry, index) => ({
        workflowId: `run-${entry.name}`,
        name: entry.name,
        compiledId: entry.workflowId,
        effectLimit: entry.effectLimit,
        submission: table[index]?.submission,
        resolver: table[index]?.resolver,
        availability: "available",
      })),
    );
  });
});

await test("CLV-075 develop-prd registers its own function with prompt input and eight effects", () => {
  const row = ticketRegistrationTable({
    repository: "/repositories/example",
    command: undefined,
  }).find((entry) => entry.workflowId === "develop-prd");
  assert.ok(row);
  assert.equal(row.functionName, "developPrd");
  assert.equal(row.effectLimit, 8);
  assert.deepEqual(row.submission, {
    maximumBytes: 65_536,
    fields: { prompt: "string" },
  });
  assert.equal(row.resolver.id, promptResolver("/repositories/example").id);
});
