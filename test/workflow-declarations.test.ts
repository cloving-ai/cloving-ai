import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  workflowDeclarations,
  workflowManifests,
} from "../tools/self-host-workflows.ts";
import { withFiles } from "./quality/files-fixture.ts";

const declaration = {
  workflowId: "review-run",
  effectLimit: 14,
  capabilities: ["claude"],
  input: {
    maximumBytes: 65_536,
    fields: {
      prompt: { type: "string" },
      rounds: { type: "integer", minimum: 1, maximum: 10, optional: true },
      publish: { type: "boolean", optional: true },
    },
  },
};
const manifests = workflowManifests({
  workflows: {
    "workflows/review-run.ts": {
      review: { workflowId: "workflow//./workflows/review-run//review" },
    },
  },
});

await test("CLV-115 admits chats only when explicitly declared", async () => {
  await withFiles(
    {
      "review-run.ts": "export {};",
      "review-run.declaration.json": JSON.stringify({
        ...declaration,
        capabilities: ["chats"],
      }),
    },
    async (directory) => {
      const declarations = await workflowDeclarations(directory, manifests);
      assert.deepEqual(declarations[0]?.capabilities, ["chats"]);
      assert.deepEqual(manifests["review"]?.capabilities, ["claude", "github"]);
    },
  );
});

await test("CLV-089 reads a declaration beside its workflow and binds its function", async () => {
  await withFiles(
    {
      "workflows/review-run.ts": "export {};",
      "workflows/review-run.declaration.json": JSON.stringify(declaration),
      "workflows/legacy.ts": "export {};",
    },
    async (directory) => {
      assert.deepEqual(
        await workflowDeclarations(join(directory, "workflows"), manifests),
        [{ ...declaration, functionName: "review" }],
      );
    },
  );
});

async function rejectsDeclaration(value: unknown): Promise<void> {
  await withFiles(
    {
      "review-run.ts": "export {};",
      "review-run.declaration.json": JSON.stringify(value),
    },
    async (directory) => {
      await assert.rejects(
        workflowDeclarations(directory, manifests),
        /invalid-workflow-declaration: review-run\.declaration\.json/,
      );
    },
  );
}

await test("CLV-089 rejects invalid declaration identifiers, budgets and capabilities", async () => {
  for (const value of [null, [], {}, { ...declaration, extra: true }])
    await rejectsDeclaration(value);
  for (const workflowId of ["", "a".repeat(65), "a_b", "a/b", 3])
    await rejectsDeclaration({ ...declaration, workflowId });
  for (const effectLimit of [0, 101, 1.5, "14", null])
    await rejectsDeclaration({ ...declaration, effectLimit });
  for (const capabilities of [[], ["other"], ["claude", 3], "claude", null])
    await rejectsDeclaration({ ...declaration, capabilities });
});

await test("CLV-089 rejects invalid input contracts and field rules", async () => {
  for (const input of [null, [], {}, { ...declaration.input, extra: true }])
    await rejectsDeclaration({ ...declaration, input });
  for (const maximumBytes of [0, 1_048_577, 1.5, "64", null])
    await rejectsDeclaration({
      ...declaration,
      input: { ...declaration.input, maximumBytes },
    });
  for (const fields of [null, [], "string"])
    await rejectsDeclaration({
      ...declaration,
      input: { ...declaration.input, fields },
    });
  for (const rule of [
    null,
    [],
    "string",
    {},
    { type: "number" },
    { type: "string", optional: "true" },
    { type: "boolean", minimum: 1 },
    { type: "string", maximum: 10 },
    { type: "integer", minimum: 1.5 },
    { type: "integer", maximum: "3" },
    { type: "integer", minimum: 3, maximum: 2 },
    { type: "integer", unknown: 1 },
  ])
    await rejectsDeclaration({
      ...declaration,
      input: { ...declaration.input, fields: { prompt: rule } },
    });
});

await test("CLV-089 rejects malformed JSON and declarations without a workflow function", async () => {
  for (const content of ["{", JSON.stringify(declaration)])
    await withFiles(
      { "empty.ts": "export {};", "empty.declaration.json": content },
      async (directory) => {
        await assert.rejects(
          workflowDeclarations(directory, {}),
          /invalid-workflow-declaration: empty\.declaration\.json/,
        );
      },
    );
});

await test("CLV-096 binds declarations beside emitted JavaScript and ignores type declarations", async () => {
  await withFiles(
    {
      "review-run.js": "export {};",
      "review-run.d.ts": "export {};",
      "review-run.declaration.json": JSON.stringify(declaration),
    },
    async (directory) => {
      assert.deepEqual(await workflowDeclarations(directory, manifests), [
        { ...declaration, functionName: "review" },
      ]);
    },
  );
});

await test("CLV-096 the package build copies JSON declaration sidecars only", async () => {
  await withFiles(
    {
      "workflows/review-run.ts": "export {};",
      "workflows/review-run.declaration.json": JSON.stringify(declaration),
      "workflows/extra.d.ts": "export interface Extra {}",
      "workflows/README.md": "do not copy",
    },
    async (directory) => {
      execFileSync(process.execPath, [
        resolve("tools/copy-workflow-declarations.ts"),
        join(directory, "workflows"),
        join(directory, "dist/workflows"),
      ]);
      for (const name of ["review-run.declaration.json"])
        assert.equal(
          await readFile(join(directory, "dist/workflows", name), "utf8"),
          await readFile(join(directory, "workflows", name), "utf8"),
        );
      for (const name of ["README.md", "extra.d.ts"])
        await assert.rejects(
          readFile(join(directory, "dist/workflows", name)),
          { code: "ENOENT" },
        );
    },
  );
});
