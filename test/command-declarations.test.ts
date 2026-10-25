import assert from "node:assert/strict";
import { test } from "node:test";
import {
  workflowDeclarations,
  workflowManifests,
} from "../tools/self-host-workflows.ts";
import { withFiles } from "./quality/files-fixture.ts";
import { isWorkflowDeclaration } from "../src/workflow-declaration.ts";
import {
  ticketRegistrationTable,
  ticketRegistrations,
} from "../src/daemon/ticket-registration.ts";
import { withProject, workflowId } from "./cli-fixture.ts";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";

const declaration = {
  workflowId: "review-queue",
  effectLimit: 4,
  capabilities: ["command"],
  commands: ["review-requests"],
  input: { maximumBytes: 64, fields: {} },
};

await test("CLV-178 registers a declaration with named commands and the command capability", async () => {
  const manifests = workflowManifests({
    workflows: {
      "review.ts": { review: { workflowId: "workflow//./review//review" } },
    },
  });
  await withFiles(
    {
      "review.ts": "export {};",
      "review.declaration.json": JSON.stringify(declaration),
    },
    async (directory) => {
      assert.deepEqual(await workflowDeclarations(directory, manifests), [
        { ...declaration, functionName: "review" },
      ]);
    },
  );
});

await test("CLV-178 an operator command registration retains its names in the admitted manifest", () =>
  withProject({}, async (_cli, directory) => {
    const file = join(directory, "review.workflow.json");
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        name: "review",
        workflowId,
        steps: [],
        capabilities: ["command"],
        resources: [],
        artifacts: "artifacts",
      }),
    );
    const table = ticketRegistrationTable(
      { repository: directory, command: undefined },
      [{ ...declaration, capabilities: ["command"], functionName: "review" }],
    ).slice(4);
    const result = await ticketRegistrations(
      { review: file },
      {
        table,
        commands: { "review-requests": ["/opt/bin/scan"] },
      },
    );
    assert.equal(result.kind, "admitted", JSON.stringify(result));
    const registration = result.registrations[0];
    assert.ok(registration);
    assert.deepEqual(registration.manifest.commands, declaration.commands);
    assert.deepEqual(registration.manifest.capabilities, ["command"]);
  }));

await test("CLV-178 refuses command capability without names and malformed command declarations", () => {
  for (const commands of [
    undefined,
    null,
    [],
    "scan",
    {},
    [1],
    [""],
    ["a_b"],
    ["a/b"],
    ["é"],
    ["a".repeat(65)],
    ["scan", "scan"],
    new Array<string>(1),
  ])
    assert.equal(isWorkflowDeclaration({ ...declaration, commands }), false);
  assert.equal(
    isWorkflowDeclaration({
      ...declaration,
      commands: ["A".repeat(64), "0-9"],
    }),
    true,
  );
  assert.equal(
    isWorkflowDeclaration({
      ...declaration,
      capabilities: ["claude"],
      commands: [],
    }),
    true,
  );
});

await test("CLV-178 refuses unknown operator command names before manifest admission", async () => {
  const table = ticketRegistrationTable(
    { repository: "/repositories/example", command: undefined },
    [{ ...declaration, capabilities: ["command"], functionName: "review" }],
  ).slice(4);
  assert.deepEqual(await ticketRegistrations({}, { table }), {
    kind: "rejected",
    detail: "command-unknown: review-queue -> review-requests",
  });
});
