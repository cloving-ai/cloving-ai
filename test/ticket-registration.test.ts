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
