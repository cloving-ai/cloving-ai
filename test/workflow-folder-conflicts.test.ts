import assert from "node:assert/strict";
import filesystem from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { loadWorkflowFolders } from "./candidate-package-fixture.ts";
import { folderInput, operatorFiles } from "./workflow-folder-fixture.ts";
import { candidateDeclaration } from "./workflow-candidate-fixtures.ts";
import { withFiles } from "./quality/files-fixture.ts";

function conflictingText(
  key: string,
  entry: { name: string; text: string },
): string {
  const { name, text } = entry;
  if (key === "workflowId" && name.endsWith(".json"))
    return text.replaceAll('"second"', '"first"');
  if (key === "functionName" && name.endsWith(".ts"))
    return text.replaceAll("second", "first");
  return text;
}

for (const [secondScope, key] of [
  ["project", "workflowId"],
  ["project", "functionName"],
  ["user", "baseName"],
  ["user", "workflowId"],
  ["user", "functionName"],
] as const) {
  await test(`CLV-124 refuses every ${key} conflict in project and ${secondScope}`, () => {
    const first = operatorFiles("project", "first");
    const second = operatorFiles(
      secondScope,
      key === "baseName" ? "first" : "second",
    );
    const files = Object.fromEntries(
      Object.entries(second).map(([name, text]) => [
        name,
        conflictingText(key, { name, text }),
      ]),
    );
    return withFiles(
      { ...first, ...files, ...operatorFiles("user", "neighbor") },
      async (directory) => {
        const input = folderInput(directory);
        const original = await loadWorkflowFolders(input);
        assert.deepEqual(
          original.candidates.map((entry) => entry.label),
          ["neighbor.ts"],
        );
        assert.deepEqual(original.refusals, [
          {
            scope: "project",
            label: "first.ts",
            codes: ["workflow-conflict"],
          },
          {
            scope: secondScope,
            label: key === "baseName" ? "first.ts" : "second.ts",
            codes: ["workflow-conflict"],
          },
        ]);
        const descriptor = Object.getOwnPropertyDescriptor(
          filesystem,
          "readdir",
        );
        assert.ok(descriptor);
        const read = filesystem.readdir;
        Object.defineProperty(filesystem, "readdir", {
          value: async (...args: Parameters<typeof read>) =>
            (await read(...args)).reverse(),
          configurable: true,
        });
        syncBuiltinESMExports();
        try {
          assert.deepEqual(await loadWorkflowFolders(input), original);
        } finally {
          Object.defineProperty(filesystem, "readdir", descriptor);
          syncBuiltinESMExports();
        }
      },
    );
  });
}

for (const workflowId of [
  "develop-ticket",
  "develop-issue",
  "develop-prompt",
  "develop-prd",
])
  await test(`CLV-262 ${workflowId} is free in project and user workflows`, async () => {
    for (const scope of ["project", "user"] as const)
      await withFiles(
        { "repo/marker": "", ...operatorFiles(scope, "candidate") },
        async (directory) => {
          const folder =
            scope === "project"
              ? "repo/.cloving/workflows"
              : "config/cloving/workflows";
          const declaration = {
            ...candidateDeclaration,
            workflow: { ...candidateDeclaration.workflow, workflowId },
          };
          await filesystem.writeFile(
            `${directory}/${folder}/candidate.declaration.json`,
            JSON.stringify(declaration),
          );
          const result = await loadWorkflowFolders(folderInput(directory));
          assert.deepEqual(result.refusals, []);
          assert.equal(result.candidates.length, 1);
          assert.equal(result.workflows[0]?.workflowId, workflowId);
        },
      );
  });

await test("CLV-124 a malformed declaration cannot hide its source base name from conflicts", () =>
  withFiles(
    {
      ...operatorFiles("project", "same"),
      ...operatorFiles("user", "same"),
      "config/cloving/workflows/same.declaration.json": "{malformed",
    },
    async (directory) => {
      const result = await loadWorkflowFolders(folderInput(directory));
      assert.deepEqual(result.candidates, []);
      assert.deepEqual(result.refusals, [
        { scope: "project", label: "same.ts", codes: ["workflow-conflict"] },
        { scope: "user", label: "same.ts", codes: ["workflow-conflict"] },
      ]);
    },
  ));
