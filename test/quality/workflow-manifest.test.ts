import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isWorkflowManifest,
  serializeManifest,
} from "../../tools/workflow-manifest.ts";

await test("CLV-074 compiled manifests require string identities in every category", () => {
  for (const [category, identifier] of [
    ["workflows", "workflowId"],
    ["steps", "stepId"],
    ["classes", "classId"],
  ] as const) {
    for (const entry of [{}, { [identifier]: null }, { [identifier]: 42 }]) {
      const value: unknown = JSON.parse(
        JSON.stringify({ [category]: { "run.ts": { run: entry } } }),
      );
      assert.equal(isWorkflowManifest(value), false, JSON.stringify(value));
    }
  }
});

await test("CLV-074 compiled manifests require object maps and entries", () => {
  for (const invalid of [null, [], "invalid", 42, true]) {
    assert.equal(isWorkflowManifest(invalid), false);
    for (const category of ["workflows", "steps", "classes"]) {
      for (const contents of [
        invalid,
        { "run.ts": invalid },
        { "run.ts": { run: invalid } },
      ]) {
        assert.equal(isWorkflowManifest({ [category]: contents }), false);
      }
    }
  }
});

await test("CLV-074 compiled manifests allow absent categories and preserve valid identities", () => {
  const manifest = {
    workflows: { "run.ts": { run: { workflowId: "workflow//run" } } },
    steps: { "step.ts": { step: { stepId: "step//step" } } },
    classes: { "value.ts": { Value: { classId: "class//Value" } } },
  };
  const value: unknown = JSON.parse(JSON.stringify(manifest));
  assert.equal(isWorkflowManifest(value), true);
  assert.equal(isWorkflowManifest({}), true);
  for (const [category, entries] of Object.entries(manifest)) {
    assert.equal(isWorkflowManifest({ [category]: entries }), true);
    assert.equal(isWorkflowManifest({ [category]: {} }), true);
  }
  assert.deepEqual(value, manifest);
});

await test("QG-07 serialization preserves every manifest identity with stable entry order", () => {
  const alpha = { stepId: "step//alpha" };
  const beta = { stepId: "step//beta" };
  const workflows = { "run.ts": { run: { workflowId: "workflow//run" } } };
  const classes = { "value.ts": { Value: { classId: "class//Value" } } };
  const first = {
    steps: { "z.ts": { beta, alpha }, "a.ts": { alpha } },
    workflows,
    classes,
  };
  const reordered = {
    classes,
    workflows,
    steps: { "a.ts": { alpha }, "z.ts": { alpha, beta } },
  };
  assert.equal(serializeManifest(first), serializeManifest(reordered));
  const parsed: unknown = JSON.parse(serializeManifest(first));
  assert.deepEqual(parsed, first);
});
