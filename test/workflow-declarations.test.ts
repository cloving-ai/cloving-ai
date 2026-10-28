import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  workflowDeclarations,
  workflowManifests,
} from "../tools/self-host-workflows.ts";
import {
  isWorkflowDeclaration,
  isWorkflowStages,
} from "../src/workflow-declaration.ts";
import {
  reviewStages,
  invalidStageSelectors,
  stageSelectors,
} from "./watch-board-fixture.ts";
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

await test("CLV-217 accepts one ticket field named ticket", () => {
  assert.ok(
    isWorkflowDeclaration({
      ...declaration,
      input: { maximumBytes: 4096, fields: { ticket: { type: "ticket" } } },
    }),
  );
});

await test("CLV-217 rejects ticket fields with another name or multiple ticket fields", () => {
  for (const fields of [
    { issue: { type: "ticket" } },
    { ticket: { type: "ticket" }, issue: { type: "ticket" } },
    { ticket: { type: "ticket", minimum: 1 } },
    { ticket: { type: "ticket", maximum: 10 } },
    { ticket: { type: ["ticket"] } },
  ])
    assert.equal(
      isWorkflowDeclaration({
        ...declaration,
        input: { maximumBytes: 4096, fields },
      }),
      false,
    );
});

await test("CLV-168 reads declared handoff targets without changing their order", async () => {
  for (const handoffs of [[], ["b"], ["b", "review-run", "A".repeat(64)]])
    await withFiles(
      {
        "review-run.ts": "export {};",
        "review-run.declaration.json": JSON.stringify({
          ...declaration,
          handoffs,
        }),
      },
      async (directory) => {
        assert.deepEqual(await workflowDeclarations(directory, manifests), [
          { ...declaration, handoffs, functionName: "review" },
        ]);
      },
    );
});

await test("CLV-168 rejects malformed, duplicate and sparse handoff targets", async () => {
  for (const handoffs of [
    null,
    "b",
    {},
    [1],
    [""],
    ["a".repeat(65)],
    ["a_b"],
    ["a/b"],
    ["é"],
    ["b", "b"],
    new Array<string>(1),
    undefined,
  ]) {
    assert.equal(isWorkflowDeclaration({ ...declaration, handoffs }), false);
    if (handoffs !== undefined)
      await rejectsDeclaration({ ...declaration, handoffs });
  }
});

await test("CLV-202 rejects the retired chats capability in bundled declarations", async () => {
  await rejectsDeclaration({ ...declaration, capabilities: ["chats"] });
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

const stage = { name: "draft", label: "Draft", operations: ["write-draft"] };

await test("CLV-234 accepts ID-only stages and preserves selectors from a sidecar", async () => {
  for (const stages of [
    reviewStages,
    ...stageSelectors.map((selectors) => [{ ...stage, ...selectors }]),
  ]) {
    assert.ok(isWorkflowStages(stages));
    const value = { ...declaration, stages };
    assert.ok(isWorkflowDeclaration(value));
    await withFiles(
      {
        "review-run.ts": "export {};",
        "review-run.declaration.json": JSON.stringify(value),
      },
      async (directory) => {
        assert.deepEqual(await workflowDeclarations(directory, manifests), [
          { ...value, functionName: "review" },
        ]);
      },
    );
  }
  assert.ok(
    isWorkflowDeclaration({
      ...declaration,
      workflowId: "another",
      stages: reviewStages,
    }),
  );
});

await test("CLV-128 accepts omitted stages and checked lists at both bounds", () => {
  assert.ok(isWorkflowDeclaration(declaration));
  for (const stages of [
    [stage],
    [{ name: "r", label: "Review", gateKinds: ["approval", "question"] }],
    [
      {
        ...stage,
        name: "N".repeat(64),
        label: "é".repeat(40),
        operations: ["a".repeat(128)],
      },
    ],
    [
      {
        ...stage,
        label: "Read <input> & save",
        operations: ["._:/-AZaz09"],
        gateKinds: [],
      },
    ],
    [{ name: "r", label: "Review", operations: [], gateKinds: ["approval"] }],
    Array.from({ length: 12 }, (_, index) => ({
      name: `s-${String(index)}`,
      label: `Stage ${String(index)}`,
      operations: [`op-${String(index)}`],
    })),
  ])
    assert.ok(isWorkflowDeclaration({ ...declaration, stages }));
});

await test("CLV-128 rejects malformed stage fields and selectors", () => {
  const invalid = [
    null,
    [],
    {},
    { ...stage, unknown: true },
    ...["", "a".repeat(65), "a_b", "é", 1].map((name) => ({ ...stage, name })),
    ...[
      "",
      "a".repeat(41),
      " Draft",
      "Draft ",
      "\tDraft",
      "a\nb",
      "a\rb",
      "a\tb",
      "a\u007fb",
      "a\u0085b",
      "a\u2028b",
      "a\u2029b",
      "a\u200bb",
      1,
      "Other",
      "Done",
      "Stopped",
    ].map((label) => ({ ...stage, label })),
    { name: "empty", label: "Empty" },
    { ...stage, operations: [] },
    {
      name: "empty",
      label: "Empty",
      gateIds: [],
      operations: [],
      gateKinds: [],
    },
    ...invalidStageSelectors.map((selectors) => ({ ...stage, ...selectors })),
  ];
  for (const item of invalid) {
    assert.equal(isWorkflowStages([item]), false);
    assert.equal(
      isWorkflowDeclaration({ ...declaration, stages: [item] }),
      false,
      JSON.stringify(item),
    );
  }
});

await test("CLV-128 rejects list bounds and shared names, labels and selector assignments", () => {
  const second = { name: "review", label: "Review", gateKinds: ["approval"] };
  for (const stages of [
    [],
    null,
    {},
    "stages",
    Array.from({ length: 13 }, (_, index) => ({
      ...stage,
      name: String(index),
      label: String(index),
      operations: [String(index)],
    })),
    [stage, { ...second, name: stage.name }],
    [stage, { ...second, label: stage.label }],
    [stage, { ...second, operations: ["write-draft"] }],
    [second, { ...stage, gateKinds: ["approval"] }],
    [
      { ...stage, gateIds: ["review"] },
      { ...second, gateIds: ["review"] },
    ],
  ])
    assert.equal(
      isWorkflowDeclaration({ ...declaration, stages }),
      false,
      JSON.stringify(stages),
    );
  assert.ok(
    isWorkflowDeclaration({
      ...declaration,
      stages: [
        { ...stage, operations: ["approval"], gateIds: ["approval"] },
        second,
      ],
    }),
  );
});

await test("CLV-128 sparse arrays cannot supply missing stages or string selectors", () => {
  const sparse = new Array<unknown>(1);
  for (const stages of [
    sparse,
    [{ ...stage, operations: sparse }],
    [{ name: "review", label: "Review", gateKinds: sparse }],
  ])
    assert.equal(isWorkflowDeclaration({ ...declaration, stages }), false);
});
