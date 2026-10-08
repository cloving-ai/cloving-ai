import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import ts from "typescript";
import { checkSuppressions } from "../../quality/suppression-approval.ts";
import type { SuppressionApproval } from "../../quality/suppression-approval.ts";

const text =
  "// @ts-expect-error: admitted negative type fixture\nexport const value: string = 1;\n";
const source = ts.createSourceFile(
  "negative.test.ts",
  text,
  ts.ScriptTarget.Latest,
  true,
);
const approval: SuppressionApproval = {
  rule: "negative-type-test",
  file: source.fileName,
  line: 1,
  sourceDigest: createHash("sha256").update(text).digest("hex"),
  justification:
    "Prove that numeric values are rejected by the string contract",
  decision: "fixture-review-1",
  removalCondition: "Remove when the tested string contract is removed",
};

await test("QG-08 accepts one exact externally approved negative type suppression", () => {
  assert.doesNotThrow(() => {
    checkSuppressions([source], [approval]);
  });
});

for (const [name, approvals] of [
  ["missing approval", []],
  ["wrong path", [{ ...approval, file: "different.test.ts" }]],
  ["wrong line", [{ ...approval, line: 2 }]],
  ["changed source", [{ ...approval, sourceDigest: "0".repeat(64) }]],
  ["duplicate approval", [approval, approval]],
  ["missing decision", [{ ...approval, decision: "" }]],
  ["missing reason", [{ ...approval, justification: "" }]],
  ["missing removal condition", [{ ...approval, removalCondition: "" }]],
] as const) {
  await test(`QG-08 rejects ${name}`, () => {
    assert.throws(() => {
      checkSuppressions([source], approvals);
    });
  });
}

await test("QG-08 rejects unused approval and expanded directive kinds", () => {
  const clean = ts.createSourceFile(
    source.fileName,
    "export {};",
    ts.ScriptTarget.Latest,
    true,
  );
  assert.throws(() => {
    checkSuppressions([clean], [approval]);
  });
  const expanded = ts.createSourceFile(
    source.fileName,
    text.replace("@ts-expect-error", "@ts-nocheck"),
    ts.ScriptTarget.Latest,
    true,
  );
  const changed = {
    ...approval,
    sourceDigest: createHash("sha256").update(expanded.text).digest("hex"),
  };
  assert.throws(() => {
    checkSuppressions([expanded], [changed]);
  });
});

await test("QG-08 approval of one marker cannot hide a second marker in the same comment", () => {
  const mixed = ts.createSourceFile(
    source.fileName,
    "// @ts-expect-error node:coverage disable\nexport const value: string = 1;",
    ts.ScriptTarget.Latest,
    true,
  );
  const changed = {
    ...approval,
    sourceDigest: createHash("sha256").update(mixed.text).digest("hex"),
  };
  assert.throws(() => {
    checkSuppressions([mixed], [changed]);
  }, /unapproved-suppression/);
});
