import assert from "node:assert/strict";
import { test } from "node:test";
import { serializeManifest } from "../../tools/workflow-manifest.ts";

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
