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
    "if (value > 0) { if (value > 1) { if (value > 2) { value--; } } }\n";
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

for (const control of controls) {
  await test(`QG-05 depth three/four for ${control.name}`, () => {
    const source = `export function example(value: number) { ${control.open.repeat(3)}value--;${control.close.repeat(3)} }`;
    assert.equal(
      lintFixture(source).some((message) => message.ruleId === "max-depth"),
      false,
    );
    const exceeded = source.replace(
      "value--;",
      `${control.open}value--;${control.close}`,
    );
    assert.equal(
      lintFixture(exceeded).filter((message) => message.ruleId === "max-depth")
        .length,
      1,
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
