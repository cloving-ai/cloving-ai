import assert from "node:assert/strict";
import { test } from "node:test";
import { workflowRefusals } from "../src/workflow-refusals.ts";

await test("CLV-124 refusal projection accepts safe labels and known codes only", () => {
  const good = {
    scope: "project",
    label: "a.ts",
    codes: ["workflow-conflict", "missing-export", "workflow-conflict"],
    source: "SOURCE_SENTINEL",
    compilerOutput: "COMPILER_SENTINEL",
  };
  const inputs = [
    null,
    {},
    { ...good, scope: "other" },
    ...["../a.ts", "/private/a.ts", "~/a.ts", "a\nb.ts", "a.ts\n"].map(
      (label) => ({ ...good, label }),
    ),
    { ...good, codes: ["/private/COMPILER_SENTINEL"] },
    { ...good, codes: [] },
    { ...good, codes: "compile-failed" },
  ];
  assert.deepEqual(workflowRefusals(inputs), []);
  assert.deepEqual(workflowRefusals(undefined), []);
  assert.deepEqual(workflowRefusals([good]), [
    {
      scope: "project",
      label: "a.ts",
      codes: ["missing-export", "workflow-conflict"],
    },
  ]);
});

await test("CLV-124 refusal ordering uses scope then label and preserves all policy codes", () => {
  const codes = [
    "invalid-declaration",
    "forbidden-import",
    "missing-export",
    "unsupported-source",
    "dynamic-effect",
    "undeclared-effect",
    "effect-limit",
    "direct-effect",
    "workflow-conflict",
    "unsafe-workflow-path",
    "workflow-read-failed",
    "workflow-source-changed",
    "compile-failed",
  ];
  const records = [
    { scope: "user", label: "workflows/", codes },
    { scope: "project", label: "z.ts", codes },
    { scope: "project", label: "file-0123456789abcdef", codes },
    { scope: "project", label: "a.ts", codes },
  ];
  const expected = [records[3], records[2], records[1], records[0]].map(
    (entry) => ({ ...entry, codes: codes.toSorted() }),
  );
  assert.deepEqual(workflowRefusals(records), expected);
  assert.deepEqual(workflowRefusals(records.toReversed()), expected);
});
