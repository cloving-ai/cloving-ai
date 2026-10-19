import assert from "node:assert/strict";
import { test } from "node:test";
import { checkWorkflowCandidate } from "../src/workflow-candidate.ts";
import { analyzeWorkflowCandidate } from "../tools/workflow-candidate-source.ts";
import {
  candidateDeclaration,
  candidateEffectExpression,
  candidateSource,
} from "./workflow-candidate-fixtures.ts";

const effect = `await ${candidateEffectExpression};`;

function checked(body: string, limit: number) {
  const facts = analyzeWorkflowCandidate(candidateSource(body));
  const declaration = {
    ...candidateDeclaration,
    workflow: { ...candidateDeclaration.workflow, effectLimit: limit },
  };
  return {
    codes: checkWorkflowCandidate({ declaration, ...facts }),
    analysis: facts.analysis,
  };
}

for (const [name, body, count] of [
  ["straight calls", `${effect} ${effect}`, 2],
  ["constant loop", `for (let index = 0; index < 3; index++) { ${effect} }`, 3],
  [
    "inclusive descending assignment",
    `for (let index = 2; index >= 1; index -= 1) { ${effect} }`,
    2,
  ],
  [
    "fractional increment",
    `for (let index = 0; index < 1; index += 0.25) { ${effect} }`,
    4,
  ],
  [
    "floating point increment",
    `for (let index = 0; index < 1; index += 0.1) { ${effect} }`,
    11,
  ],
  [
    "effectful case labels",
    `switch (input.units) { case await ${candidateEffectExpression}: break; case await ${candidateEffectExpression}: break; }`,
    2,
  ],
  [
    "loop binding defaults",
    `for (const [value = await ${candidateEffectExpression}] of [[], []]) {}`,
    2,
  ],
  [
    "negative start",
    `for (let index = -1; index < 1; index++) { ${effect} }`,
    2,
  ],
  [
    "negative bound",
    `for (let index = 0; index > -2; index--) { ${effect} }`,
    2,
  ],
  [
    "positive unary start",
    `for (let index = +0; index < 2; index++) { ${effect} }`,
    2,
  ],
  [
    "signed increment",
    `for (let index = 0; index < 2; index += +1) { ${effect} }`,
    2,
  ],
  [
    "parenthesized bound",
    `for (let index = (0); index < (2); index++) { ${effect} }`,
    2,
  ],
  [
    "inclusive loop",
    `for (let index = 1; index <= 3; index += 1) { ${effect} }`,
    3,
  ],
  [
    "descending loop",
    `for (let index = 3; index > 0; index--) { ${effect} }`,
    3,
  ],
  [
    "nested loop",
    `for (let first = 0; first < 2; first++) { for (let second = 0; second < 2; second++) { ${effect} } }`,
    4,
  ],
] as const) {
  await test(`CLV-121 counts ${name} and admits only at the exact limit`, () => {
    assert.deepEqual(checked(body, count - 1).codes, ["effect-limit"]);
    const exact = checked(body, count);
    assert.deepEqual(exact.codes, []);
    assert.equal(exact.analysis.knownCallCount, count);
    assert.equal(exact.analysis.knownUnitTotal, count);
  });
}

await test("CLV-121 charges static units rather than only call sites", () => {
  const units = effect.replace("units: 1", "units: 3");
  assert.deepEqual(checked(units, 2).codes, ["effect-limit"]);
  assert.deepEqual(checked(units, 3).codes, []);
  assert.equal(checked(units, 3).analysis.knownUnitTotal, 3);
});

for (const units of ["+3", "(3)", "(+3)"]) {
  await test(`CLV-121 counts wrapped literal units ${units}`, () => {
    const body = effect.replace("units: 1", `units: ${units}`);
    assert.deepEqual(checked(body, 2).codes, ["effect-limit"]);
    assert.deepEqual(checked(body, 3).codes, []);
  });
}

await test("CLV-121 unknown numeric controls and invalid units never become a static permission proof", () => {
  for (const control of [
    ";;",
    "let index; index < 3; index++",
    "let index = input.units; index < 3; index++",
    "let first = 0, second = 0; first < 3; first++",
    "let { index } = { index: 0 }; index < 3; index++",
    "let index = 0; input.units; index++",
    "let index = 0; input.units < 3; index++",
    "let index = 0; index < input.units; index++",
    "let index = 0; index < 3;",
    "let index = 0; index < 3; index = 1",
    "let index = 0; index < 3; index += input.units",
    "let index = 0; index < 3; !index",
    "let index = 0; index !== 3; index++",
    "let index = 0; index < 1e999; index++",
    "let index = 0; index < ~1; index++",
  ])
    assert.deepEqual(
      checked(`for (${control}) { ${effect} }`, 1).codes,
      [],
      control,
    );
  for (const units of [
    "0",
    "-1",
    "1.5",
    "9007199254740992",
    "input.units",
    "1 as number",
  ])
    assert.equal(
      checked(effect.replace("units: 1", `units: ${units}`), 1).analysis
        .knownUnitTotal,
      0,
      units,
    );
  assert.deepEqual(checked(`if (input.units) { ${effect} }`, 1).codes, []);
});

await test("CLV-121 larger branches are charged without adding mutually exclusive calls", () => {
  const body = `if (input.units) { ${effect} } else { ${effect} }`;
  assert.deepEqual(checked(body, 1).codes, []);
  assert.equal(checked(body, 1).analysis.knownUnitTotal, 1);
  const conditional = `return input.units ? ${candidateEffectExpression} : ${candidateEffectExpression};`;
  assert.deepEqual(checked(conditional, 1).codes, []);
  assert.deepEqual(
    checked(`if (input.units) { ${effect} ${effect} } else { ${effect} }`, 1)
      .codes,
    ["effect-limit"],
  );
});

await test("CLV-121 unknown loops and units leave enforcement to runtime", () => {
  const body = `while (input.units) { ${effect.replace("units: 1", "units: input.units")} }`;
  assert.deepEqual(checked(body, 1).codes, []);
  assert.equal(checked(body, 1).analysis.knownUnitTotal, 0);
  assert.equal(
    checked(effect.replace("units: 1", "units: input.units as 1"), 1).analysis
      .knownUnitTotal,
    0,
  );
});

for (const [name, body, limit, expected] of [
  [
    "static array loops",
    `for (const value of [1, 2, 3]) { ${effect} }`,
    2,
    ["effect-limit"],
  ],
  [
    "loop headers",
    `for (${candidateEffectExpression}; input.units; input.units--) { ${effect} }`,
    1,
    ["effect-limit"],
  ],
  [
    "switch branches",
    `switch (input.units) { case 1: ${effect} break; default: ${effect} }`,
    1,
    [],
  ],
] as const) {
  await test(`CLV-121 budgets account for ${name}`, () => {
    assert.deepEqual(checked(body, limit).codes, expected);
  });
}
