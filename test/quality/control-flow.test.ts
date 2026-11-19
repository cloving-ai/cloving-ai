import assert from "node:assert/strict";
import { test } from "node:test";
import { lintFixture } from "./lint-fixture.ts";

await test("QG-04 classic cyclomatic complexity is limited to ten", () => {
  const branch = "if (value > 0) value--;\n";
  const source = `export function example(value: number) {\n${branch.repeat(9)}return value;\n}`;
  assert.deepEqual(lintFixture(source), []);
  const exceeded = lintFixture(
    source.replace("return value;", `${branch}return value;`),
  );
  assert.equal(
    exceeded.filter((message) => message.ruleId === "complexity").length,
    1,
  );
  assert.match(
    exceeded.find((message) => message.ruleId === "complexity")?.message ?? "",
    /11.*10/,
  );
});

await test("QG-04 cognitive complexity 15 passes and both excessive diagnostics survive", () => {
  const nested =
    "if (value > 0) { while (value > 1) { if (value > 2) { value--; } } }\n";
  const branch = "if (value > 0) value--;\n";
  const source = `export function example(value: number) {\n${nested.repeat(2)}${branch.repeat(3)}return value;\n}`;
  assert.deepEqual(lintFixture(source), []);
  const exceeded = lintFixture(
    source.replace(
      "if (value > 0) value--;",
      "if (value > 0 && value < 10) value--;",
    ),
  );
  assert.deepEqual(exceeded.map((message) => message.ruleId).sort(), [
    "complexity",
    "sonarjs/cognitive-complexity",
  ]);
  assert.match(
    exceeded.find(
      (message) => message.ruleId === "sonarjs/cognitive-complexity",
    )?.message ?? "",
    /16.*15/,
  );
});

const controls = [
  {
    name: "classic for",
    open: "for (let index = 0; index < 1; index++) {",
    close: "}",
  },
  { name: "for of", open: "for (const value of [1]) {", close: "}" },
  { name: "for in", open: "for (const key in { value: 1 }) {", close: "}" },
  { name: "while", open: "while (value > 0) {", close: "}" },
  { name: "if", open: "if (value > 0) {", close: "}" },
  { name: "try", open: "try {", close: "} catch { throw new Error(); }" },
];

const loop = { open: "while (value > 0) {", close: "}" };

function nest(levels: readonly { open: string; close: string }[]): string {
  const opens = levels.map((level) => level.open).join("");
  const closes = levels
    .map((level) => level.close)
    .reverse()
    .join("");
  return `export function example(value: number) { ${opens}value--;${closes} }`;
}

for (const control of controls) {
  await test(`QG-05 depth three/four for ${control.name}`, () => {
    assert.deepEqual(lintFixture(nest([loop, loop, control])), []);
    assert.deepEqual(
      lintFixture(nest([control, loop, loop, control])).map(
        (message) => message.ruleId,
      ),
      ["max-depth"],
    );
  });
}

for (const scenario of [
  {
    rule: "no-else-return",
    source:
      "export function example(value: number) { if (value) { return 1; } else { return 2; } }",
  },
  {
    rule: "no-lonely-if",
    source:
      "export function example(value: number) { if (value) { value++; } else { if (value > 1) { value--; } } }",
  },
  {
    rule: "no-nested-ternary",
    source: "export const value = 1 ? (2 ? 3 : 4) : 5;",
  },
]) {
  await test(`QG-05 rejects ${scenario.rule}`, () => {
    assert.equal(
      lintFixture(scenario.source).filter(
        (message) => message.ruleId === scenario.rule,
      ).length,
      1,
    );
  });
}

for (const shape of [
  {
    block: "then",
    source:
      "export function example(value: number) { if (value > 0) { if (value > 1) { value--; } } return value; }",
  },
  {
    block: "else",
    source:
      "export function example(value: number) { if (value > 0) { value++; } else { value--; if (value < -1) { value++; } } return value; }",
  },
]) {
  await test(`#835 an if statement directly in the ${shape.block} block of another if statement is rejected with a guard clause hint`, () => {
    const findings = lintFixture(shape.source);
    assert.deepEqual(
      findings.map((finding) => finding.ruleId),
      ["no-restricted-syntax"],
    );
    assert.match(findings[0]?.message ?? "", /guard clause/);
  });
}

await test("#835 a guard clause before the second if statement is accepted", () => {
  assert.deepEqual(
    lintFixture(
      "export function example(value: number) { if (value <= 0) return value; if (value > 1) { value--; } return value; }",
    ),
    [],
  );
});
