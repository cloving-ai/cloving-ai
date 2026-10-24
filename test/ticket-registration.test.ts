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
import { queryDatabase } from "./authority-store-fixture.ts";
import { call, field, text, withHarness } from "./service-fixture.ts";
import { workflowPin } from "../src/broker/workflow-pin.ts";
import { readExecutionManifest } from "../src/execution-pin.ts";

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

await test("CLV-161 a daemon registration stores the serving bundle digest in the durable execution pin", () =>
  withProject({}, async (_cli, directory) => {
    const manifests = await manifestsIn(directory);
    const bundleDigest = "a".repeat(64);
    const options = {
      table: ticketRegistrationTable({
        repository: directory,
        command: undefined,
      }),
      bundleDigest,
    };
    const admitted = await ticketRegistrations(
      {
        developPrd: manifests["develop"],
        developTicket: manifests["developOther"],
      },
      options,
    );
    assert.equal(admitted.kind, "admitted", JSON.stringify(admitted));
    await withHarness(async (harness) => {
      const service = await harness.start({
        workflows: admitted.registrations,
      });
      const result = await call(harness, {
        operation: "run",
        parameters: {
          workflowId: "develop-prompt",
          source: "prompt",
          submission: { prompt: "Task" },
          commandId: "pinned",
        },
      });
      assert.equal(result["kind"], "run-admitted");
      await service.close();
      const rows = queryDatabase(
        harness.stateDirectory,
        "SELECT pin, manifest FROM definitions",
      );
      assert.equal(rows.length, 1);
      const stored = readExecutionManifest(
        JSON.parse(text(rows[0], "manifest")),
      );
      assert.equal(field(stored, "bundleDigest"), bundleDigest);
      assert.equal(text(rows[0], "pin"), workflowPin(stored));
      assert.equal(
        field(field(result, "binding"), "workflowPin"),
        workflowPin(stored),
      );
    });
  }));

await test("CLV-169 only develop-prd declares the develop-issue handoff", () => {
  const table = ticketRegistrationTable({
    repository: "/repositories/example",
    command: undefined,
  });
  assert.deepEqual(
    table.map((row) => [row.workflowId, row.handoffs]),
    [
      ["develop-ticket", []],
      ["develop-issue", []],
      ["develop-prd", ["develop-issue"]],
      ["develop-prompt", []],
    ],
  );
});

await test("CLV-169 the PRD handoff survives manifest admission", async () => {
  await withProject({}, async (_cli, directory) => {
    const manifests = await manifestsIn(directory);
    const table = ticketRegistrationTable({
      repository: directory,
      command: undefined,
    });
    const admitted = await ticketRegistrations(
      {
        developPrd: manifests["develop"],
        developTicket: manifests["developOther"],
      },
      { table },
    );
    assert.equal(admitted.kind, "admitted", JSON.stringify(admitted));
    const prd = admitted.registrations.find(
      (row) => row.workflowId === "develop-prd",
    );
    assert.ok(prd);
    assert.deepEqual(prd.handoffs, ["develop-issue"]);
    assert.deepEqual(prd.manifest.handoffs, ["develop-issue"]);
  });
});

await test("CLV-168 unknown handoff targets refuse registration before manifest admission", async () => {
  for (const handoffs of [["missing"], ["develop-ticket", "missing"]]) {
    const table = ticketRegistrationTable(
      { repository: "/repositories/example", command: undefined },
      [{ ...declared, handoffs }],
    );
    assert.deepEqual(await ticketRegistrations({}, { table }), {
      kind: "rejected",
      detail: "unknown-handoff-target: review-run -> missing",
    });
  }
});

await test("CLV-168 registrations retain forward, self and cyclic handoff declarations", async () => {
  await withProject({}, async (_cli, directory) => {
    const table = ticketRegistrationTable(
      { repository: directory, command: undefined },
      [
        {
          ...declared,
          workflowId: "a",
          functionName: "develop",
          capabilities: ["claude", "github"],
          handoffs: ["b", "a"],
        },
        {
          ...declared,
          workflowId: "b",
          capabilities: ["claude", "github"],
          handoffs: ["a"],
        },
      ],
    ).slice(4);
    const admitted = await ticketRegistrations(await manifestsIn(directory), {
      table,
    });
    assert.equal(admitted.kind, "admitted", JSON.stringify(admitted));
    assert.deepEqual(
      admitted.registrations.map((row) => [
        row.workflowId,
        row.handoffs,
        row.manifest.handoffs,
      ]),
      [
        ["a", ["b", "a"], ["b", "a"]],
        ["b", ["a"], ["a"]],
      ],
    );
  });
});

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
  assert.deepEqual(row.handoffs, ["develop-issue"]);
  assert.deepEqual(row.submission, {
    maximumBytes: 65_536,
    fields: { prompt: "string" },
  });
  assert.equal(row.resolver.id, promptResolver("/repositories/example").id);
});
