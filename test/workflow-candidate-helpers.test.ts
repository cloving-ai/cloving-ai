import assert from "node:assert/strict";
import { test } from "node:test";
import { checkWorkflowCandidate } from "../src/workflow-candidate.ts";
import { candidatePackageRoot } from "./candidate-package-fixture.ts";
import { analyzeWorkflowCandidate as analyzeHelpers } from "../tools/workflow-candidate-source.ts";
import {
  candidateDeclaration,
  candidateEffectExpression,
  candidateSource,
} from "./workflow-candidate-fixtures.ts";

const effect = `await ${candidateEffectExpression};`;

function helperAnalysis(body: string, helperBody = effect) {
  return analyzeHelpers(
    `import { perform as invoke } from "./helpers/effects.ts";
${candidateSource(body)}`,
    {
      packageRoot: candidatePackageRoot,
      helpers: {
        "helpers/effects.ts": `import { protectedEffect } from "cloving/workflows";
export async function perform() { ${helperBody} }`,
      },
    },
  );
}

for (const [name, body, count] of [
  ["repeated aliased calls", "await invoke(); await invoke();", 2],
  [
    "fixed loops",
    "for (let index = 0; index < 3; index++) { await invoke(); }",
    3,
  ],
  ["array loops", "for (const value of [1, 2, 3]) { await invoke(); }", 3],
  [
    "exclusive branches",
    "if (input.units) await invoke(); else await invoke();",
    1,
  ],
  [
    "local wrappers",
    "await wrapper(); await wrapper(); } async function wrapper() { await invoke();",
    2,
  ],
] as const) {
  await test(`CLV-216 counts helper effects at ${name}`, () => {
    const facts = helperAnalysis(body);
    assert.equal(facts.analysis.knownCallCount, count);
    assert.equal(facts.analysis.knownUnitTotal, count);
    assert.deepEqual(
      checkWorkflowCandidate({
        declaration: {
          ...candidateDeclaration,
          workflow: { ...candidateDeclaration.workflow, effectLimit: count },
        },
        ...facts,
      }),
      [],
    );
    assert.deepEqual(
      checkWorkflowCandidate({ declaration: candidateDeclaration, ...facts }),
      count > 1 ? ["effect-limit"] : [],
    );
  });
}

for (const body of [
  "const alias = invoke; await alias(); await alias();",
  "await Promise.all([1, 2].map(invoke));",
  "await Promise.all([1, 2].map(() => invoke()));",
  "while (input.units) { await invoke(); }",
  "for (let index = 0; index < input.units; index++) { await invoke(); }",
  "for (const value of input.values) { await invoke(); }",
  "await invoke(); } async function wrapper() { await wrapper(); await invoke();",
]) {
  await test(`CLV-216 refuses uncheckable effectful helper usage: ${body}`, () => {
    const facts = helperAnalysis(body);
    assert.deepEqual(
      checkWorkflowCandidate({ declaration: candidateDeclaration, ...facts }),
      ["unsupported-source"],
    );
  });
}

await test("CLV-216 multiplies helper units", () => {
  const facts = helperAnalysis(
    "await invoke(); await invoke();",
    `${effect.replace("units: 1", "units: 3")} ${effect.replace("units: 1", "units: 3")}`,
  );
  assert.equal(facts.analysis.knownCallCount, 4);
  assert.equal(facts.analysis.knownUnitTotal, 12);
});

await test("CLV-216 counts fixed loop repetitions inside a repeatedly called helper", () => {
  const facts = helperAnalysis(
    "await invoke(); await invoke();",
    `for (let index = 0; index < 3; index++) { ${effect} }`,
  );
  assert.equal(facts.analysis.knownCallCount, 6);
  assert.equal(facts.analysis.knownUnitTotal, 6);
});

await test("CLV-216 refuses unknown repetitions inside an effectful helper", () => {
  const facts = helperAnalysis("await invoke();", `while (true) { ${effect} }`);
  assert.deepEqual(
    checkWorkflowCandidate({ declaration: candidateDeclaration, ...facts }),
    ["unsupported-source"],
  );
});

await test("CLV-216 counts effectful helper arguments as well as the invoked helper", () => {
  const facts = helperAnalysis("await invoke(await invoke());");
  assert.equal(facts.analysis.knownCallCount, 2);
  assert.equal(facts.analysis.knownUnitTotal, 2);
});

await test("CLV-216 follows repeated calls through transitive helper imports", () => {
  const facts = analyzeHelpers(
    `import { wrapper } from "./helpers/wrapper.ts";
${candidateSource("await wrapper(); await wrapper();")}`,
    {
      packageRoot: candidatePackageRoot,
      helpers: {
        "helpers/wrapper.ts": `import { perform } from "./nested/effects.ts";
export async function wrapper() { await perform(); await perform(); }`,
        "helpers/nested/effects.ts": `import { protectedEffect } from "cloving/workflows";
export async function perform() { ${effect} }`,
      },
    },
  );
  assert.equal(facts.analysis.knownCallCount, 4);
  assert.equal(facts.analysis.knownUnitTotal, 4);
  assert.deepEqual(
    checkWorkflowCandidate({
      declaration: {
        ...candidateDeclaration,
        workflow: { ...candidateDeclaration.workflow, effectLimit: 4 },
      },
      ...facts,
    }),
    [],
  );
});

await test("CLV-216 leaves pure helper callbacks and recursion available", () => {
  const facts = helperAnalysis(
    "return [1, 2].map(invoke);",
    "return perform();",
  );
  assert.deepEqual(
    checkWorkflowCandidate({ declaration: candidateDeclaration, ...facts }),
    [],
  );
});

await test("CLV-216 a pure import preserves direct workflow recursion accounting", () => {
  const facts = helperAnalysis(
    `${effect} if (input.units) await candidate(input);`,
    "return 1;",
  );
  assert.deepEqual(
    checkWorkflowCandidate({ declaration: candidateDeclaration, ...facts }),
    [],
  );
});
