import assert from "node:assert/strict";
import filesystem from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { loadWorkflowFolders } from "./candidate-package-fixture.ts";
import { folderInput, operatorFiles } from "./workflow-folder-fixture.ts";
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

for (const key of ["baseName", "workflowId", "functionName"] as const) {
  await test(`CLV-124 bundled ${key} remains reserved against both scopes`, () =>
    withFiles(
      {
        ...operatorFiles("project", "project"),
        ...operatorFiles("user", "user"),
      },
      async (directory) => {
        const result = await loadWorkflowFolders({
          ...folderInput(directory),
          bundled: ["project", "user"].map((name) => ({
            baseName: "bundled-base",
            workflowId: "bundled-id",
            functionName: "bundledFunction",
            [key]: name,
          })),
        });
        assert.deepEqual(result.candidates, []);
        assert.deepEqual(result.refusals, [
          {
            scope: "project",
            label: "project.ts",
            codes: ["bundled-name-reserved"],
          },
          { scope: "user", label: "user.ts", codes: ["bundled-name-reserved"] },
        ]);
      },
    ));
}

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
