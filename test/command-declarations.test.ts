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

const reviewWait = {
  command: "review-requests",
  maximumWaitSeconds: 2_592_000,
  pollEverySeconds: 3_600,
};

await test("CLV-235 accepts bounded named command waits and absent declarations", () => {
  assert.equal(isWorkflowDeclaration(declaration), true);
  for (const commandWaits of [
    {},
    { "team-review": reviewWait },
    {
      A: { ...reviewWait, maximumWaitSeconds: 60, pollEverySeconds: 60 },
      ["0-9".repeat(21) + "A"]: { ...reviewWait, pollEverySeconds: 86_400 },
    },
  ])
    assert.equal(
      isWorkflowDeclaration({ ...declaration, commandWaits }),
      true,
      JSON.stringify(commandWaits),
    );
});

await test("CLV-235 rejects malformed wait maps, names and exact entry shapes", () => {
  const entries = [
    null,
    undefined,
    [],
    "review-requests",
    {},
    { ...reviewWait, extra: true },
    { ...reviewWait, command: undefined },
    { ...reviewWait, command: null },
    { ...reviewWait, command: "unknown" },
    { ...reviewWait, command: "constructor" },
  ];
  const names = ["", "a".repeat(65), "a_b", "a/b", "é", "a\n"];
  for (const commandWaits of [
    null,
    undefined,
    [],
    "team-review",
    ...entries.map((entry) => ({ "team-review": entry })),
    ...names.map((name) => ({ [name]: reviewWait })),
  ])
    assert.equal(
      isWorkflowDeclaration({ ...declaration, commandWaits }),
      false,
      JSON.stringify(commandWaits),
    );
});

await test("CLV-235 rejects wait bounds and missing declared command authority", () => {
  for (const field of ["maximumWaitSeconds", "pollEverySeconds"])
    for (const value of [undefined, null, "60", 60.5, 0, 59, Infinity, NaN])
      assert.equal(
        isWorkflowDeclaration({
          ...declaration,
          commandWaits: { review: { ...reviewWait, [field]: value } },
        }),
        false,
        `${field}: ${String(value)}`,
      );
  for (const extra of [
    { maximumWaitSeconds: 2_592_001 },
    { pollEverySeconds: 86_401 },
    { maximumWaitSeconds: 60, pollEverySeconds: 61 },
  ])
    assert.equal(
      isWorkflowDeclaration({
        ...declaration,
        commandWaits: { review: { ...reviewWait, ...extra } },
      }),
      false,
    );
  for (const extra of [
    { capabilities: ["claude"] },
    { commands: ["other-command"] },
    { commands: [] },
    { commands: undefined },
  ])
    assert.equal(
      isWorkflowDeclaration({
        ...declaration,
        ...extra,
        commandWaits: { review: reviewWait },
      }),
      false,
    );
});

await test("CLV-235 reads named command waits beside their workflow", async () => {
  const manifests = workflowManifests({
    workflows: {
      "review.ts": { review: { workflowId: "workflow//./review//review" } },
    },
  });
  await withFiles(
    {
      "review.ts": "export {};",
      "review.declaration.json": JSON.stringify({
        ...declaration,
        commandWaits: { "team-review": reviewWait },
      }),
    },
    async (directory) => {
      assert.deepEqual(await workflowDeclarations(directory, manifests), [
        {
          ...declaration,
          commandWaits: { "team-review": reviewWait },
          functionName: "review",
        },
      ]);
    },
  );
});

await test("CLV-235 operator registration retains commands and waits in the admitted manifest", () =>
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
      [
        {
          ...declaration,
          capabilities: ["command"],
          functionName: "review",
          commandWaits: { "team-review": reviewWait },
        },
      ],
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
    assert.deepEqual(registration.commandWaits, { "team-review": reviewWait });
    assert.deepEqual(registration.manifest.commandWaits, {
      "team-review": reviewWait,
    });
  }));

await test("CLV-235 registration refuses invalid wait permissions before reading manifests", async () => {
  const table = ticketRegistrationTable(
    { repository: "/repositories/example", command: undefined },
    [{ ...declaration, capabilities: ["command"], functionName: "review" }],
  ).slice(4);
  for (const extra of [
    { commandWaits: { review: { ...reviewWait, command: "other" } } },
    { commandWaits: { review: reviewWait }, capabilities: ["claude"] },
  ])
    assert.deepEqual(
      await ticketRegistrations(
        {},
        {
          table: table.map((row) => ({ ...row, ...extra })),
          commands: { "review-requests": ["/opt/bin/scan"] },
        },
      ),
      {
        kind: "rejected",
        detail: "invalid-command-waits: review-queue",
      },
    );
});

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
    [
      {
        ...declaration,
        capabilities: ["command"],
        functionName: "review",
        commandWaits: { review: reviewWait },
      },
    ],
  ).slice(4);
  assert.deepEqual(await ticketRegistrations({}, { table }), {
    kind: "rejected",
    detail: "command-unknown: review-queue -> review-requests",
  });
});
