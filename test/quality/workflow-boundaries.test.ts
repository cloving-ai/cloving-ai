import assert from "node:assert/strict";
import { basename } from "node:path";
import { test } from "node:test";
import { inspectWorkflowBoundaries } from "../../quality/workflow-boundaries.ts";
import { withProgram } from "./program-fixture.ts";

const step =
  'export async function execute(input: { id: string }) { "use step"; return { id: input.id }; }';

async function findings(sources: Readonly<Record<string, string>>) {
  return await withProgram(sources, (program) => {
    const files = program.getRootFileNames();
    const roles = Object.fromEntries(
      files.map((file) => [
        file,
        basename(file) === "step.ts" ? "step" : "workflow",
      ]),
    );
    const stepExports = Object.fromEntries(
      files
        .filter((file) => basename(file) === "step.ts")
        .map((file) => [file, ["execute"]]),
    );
    return inspectWorkflowBoundaries(program, { roles, stepExports });
  });
}

await test("QG-06 allows composition callbacks that stay outside the step boundary", async () => {
  assert.deepEqual(
    await findings({
      "step.ts": step,
      "flow.ts":
        'import { execute as run } from "./step.js"; export async function workflow(ids: string[]) { "use workflow"; return await Promise.all(ids.map(async (id) => await run({ id }))); }',
    }),
    [],
  );
});

for (const [name, body, expected] of [
  [
    "nested declaration",
    'export async function workflow() { "use workflow"; async function inner() { "use step"; return 1; } return await inner(); }',
    "invalid-durable-definition",
  ],
  [
    "step value escape",
    'import { execute } from "./step.js"; export async function workflow() { "use workflow"; const hidden = execute.bind(null); return await hidden({ id: "one" }); }',
    "step-value-escape",
  ],
] as const) {
  await test(`QG-06 rejects ${name}`, async () => {
    assert.ok(
      (await findings({ "step.ts": step, "flow.ts": body })).some((finding) =>
        finding.includes(expected),
      ),
    );
  });
}

await test("QG-06 rejects nested steps through a local wrapper", async () => {
  const source =
    step +
    '\nfunction wrapper() { return execute({ id: "one" }); } export async function nested() { "use step"; return await wrapper(); }';
  assert.ok(
    (await findings({ "step.ts": source })).some((finding) =>
      finding.includes("nested-durable-step"),
    ),
  );
});

for (const [type, value] of [
  ["() => number", "() => 1"],
  ["{ send: () => void }", "{ send: () => {} }"],
] as const) {
  await test(`QG-06 rejects nonserializable step data ${type}`, async () => {
    const source = `export async function execute(input: { callback: ${type} }) { "use step"; return input; }`;
    assert.ok(
      (
        await findings({
          "step.ts": source,
          "flow.ts": `import { execute } from "./step.js"; export async function workflow() { "use workflow"; return await execute({ callback: ${value} }); }`,
        })
      ).some((finding) => finding.includes("nonserializable-step")),
    );
  });
}

await test("QG-06 rejects a workflow renamed into an unrelated module role", async () => {
  await withProgram(
    {
      "renamed.ts":
        'export async function workflow() { "use workflow"; return 1; }',
    },
    (program) => {
      const roles = Object.fromEntries(
        program.getRootFileNames().map((file) => [file, "pure"]),
      );
      assert.ok(
        inspectWorkflowBoundaries(program, { roles, stepExports: {} }).some(
          (finding) => finding.includes("unmapped-workflow"),
        ),
      );
    },
  );
});

for (const [name, source, rule] of [
  [
    "typed shorthand escape",
    step +
      ' const holder: { execute: (input: { id: string }) => Promise<{ id: string }> } = { execute }; export async function nested() { "use step"; return await holder.execute({ id: "one" }); }',
    "step-value-escape",
  ],
  [
    "numeric index callbacks",
    'export async function execute(input: { id: string; [key: number]: () => void }) { "use step"; return input.id; }',
    "nonserializable-step-parameter",
  ],
  [
    "callback return value",
    'export async function execute() { "use step"; return () => 1; }',
    "nonserializable-step-result",
  ],
] as const) {
  await test(`QG-06 rejects ${name}`, async () => {
    assert.ok(
      (await findings({ "step.ts": source })).some((finding) =>
        finding.includes(rule),
      ),
    );
  });
}

await test("QG-06 tests may call a step helper directly while other roles may not", async () => {
  const roles: Readonly<Record<string, string>> = {
    "step.ts": "step",
    "unit.test.ts": "test",
    "helper.ts": "pure",
  };
  const result = await withProgram(
    {
      "step.ts": step,
      "unit.test.ts":
        'import { execute } from "./step.js"; export async function check() { return await execute({ id: "one" }); }',
      "helper.ts":
        'import { execute } from "./step.js"; export async function other() { return await execute({ id: "two" }); }',
    },
    (program) =>
      inspectWorkflowBoundaries(program, {
        roles: Object.fromEntries(
          program
            .getRootFileNames()
            .map((file) => [file, roles[basename(file)] ?? "workflow"]),
        ),
        stepExports: {},
      }),
  );
  assert.equal(
    result.some((finding) => finding.includes("unit.test.ts")),
    false,
  );
  assert.ok(
    result.some(
      (finding) =>
        finding.startsWith("unadmitted-step-call") &&
        finding.includes("helper.ts"),
    ),
  );
});
