import assert from "node:assert/strict";
import { test } from "node:test";
import ts from "typescript";
import { inspectSuppressions } from "../../quality/suppressions.ts";

for (const marker of [
  "eslint-disable",
  "eslint-enable",
  "eslint max-lines: off",
  "oxlint-disable",
  "@ts-ignore",
  "@ts-nocheck",
  "@ts-expect-error",
  "istanbul ignore next",
  "c8 ignore next",
  "v8 ignore next",
  "jscpd:ignore-start",
  "node:coverage disable",
  "node:coverage ignore next",
]) {
  await test(`QG-08 rejects unapproved comment directive ${marker}`, () => {
    const source = ts.createSourceFile(
      "fixture.ts",
      `export {};\n/* ${marker} */`,
      ts.ScriptTarget.Latest,
      true,
    );
    const findings = inspectSuppressions(source);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.line, 2);
  });
}

await test("QG-08 finds comments inside empty blocks and template expressions", () => {
  const source = ts.createSourceFile(
    "fixture.ts",
    "function first() { /* @ts-ignore */ }\nconst value = `${1 /* c8 ignore next */}`;",
    ts.ScriptTarget.Latest,
    true,
  );
  assert.equal(inspectSuppressions(source).length, 2);
});

await test("QG-08 leaves literal fixture data and ordinary comments intact", () => {
  const source = ts.createSourceFile(
    "fixture.ts",
    'const example = "/* eslint-disable */";\nconst template = `// @ts-ignore`;\n/* ordinary explanation */',
    ts.ScriptTarget.Latest,
    true,
  );
  assert.deepEqual(inspectSuppressions(source), []);
});
