import assert from "node:assert/strict";
import { test } from "node:test";
import { checkWorkflowCandidate } from "../src/workflow-candidate.ts";
import { analyzeWorkflowCandidate } from "./candidate-package-fixture.ts";
import {
  candidateDeclaration,
  combinedCandidateSource,
  candidateEffectExpression,
  candidateSource,
  forbiddenCandidateModules,
  unsupportedCandidateSources,
  validCandidateSource,
} from "./workflow-candidate-fixtures.ts";

function check(source: string, declaration: unknown = candidateDeclaration) {
  return checkWorkflowCandidate({
    declaration,
    ...analyzeWorkflowCandidate(source),
  });
}

for (const statement of [
  'throw new Error("SOURCE_SENTINEL");',
  "export const developTicket = 1;",
  'const parsed = JSON.parse("SOURCE_SENTINEL");',
  "while (true) {}",
  "const { value } = null;",
  'class Unsafe { static value = JSON.parse("SOURCE_SENTINEL"); }',
  'const value = { get answer() { throw new Error("SOURCE_SENTINEL"); } };',
]) {
  await test(`CLV-124 refuses executable module initialization ${statement}`, () => {
    assert.deepEqual(check(`${statement}\n${validCandidateSource}`), [
      "unsupported-source",
    ]);
  });
}

await test("CLV-124 accepts passive module constants, type declarations and deferred function bodies", () => {
  assert.deepEqual(
    check(`
const config = { rounds: [1, -2], label: "ready", enabled: true, empty: null } as const;
type Input = { value: string };
interface Output { value: string }
function deferred() { throw new Error("runtime-only"); }
const deferredArrow = () => { throw new Error("runtime-only"); };
${validCandidateSource}`),
    [],
  );
});

await test("CLV-121 the actual combined source produces both refusal codes without execution", () => {
  assert.deepEqual(check(combinedCandidateSource), [
    "missing-export",
    "undeclared-effect",
  ]);
  assert.deepEqual(check(combinedCandidateSource), [
    "missing-export",
    "undeclared-effect",
  ]);
});

await test("CLV-121 source imports use installed types and values, retaining valid aliases", () => {
  for (const module of forbiddenCandidateModules) {
    const source = `${validCandidateSource}\nimport { helper } from ${JSON.stringify(module)};`;
    assert.deepEqual(check(source), ["forbidden-import"], module);
  }
  for (const name of ["MissingValue", "MissingType"])
    assert.deepEqual(
      check(
        `${validCandidateSource}\nimport type { ${name} } from "cloving/workflows";`,
      ),
      ["missing-export"],
    );
  assert.deepEqual(
    check(
      validCandidateSource
        .replaceAll("protectedEffect", "effect")
        .replace("{ effect }", "{ protectedEffect as effect }"),
    ),
    [],
  );
  assert.deepEqual(
    check(
      `${validCandidateSource}\nimport type { ProtectedRequest as Request } from "cloving/workflows";`,
    ),
    [],
  );
  const { installedExports } = analyzeWorkflowCandidate(validCandidateSource);
  assert.ok(
    installedExports["cloving/workflows"]?.includes("ProtectedRequest"),
  );
  assert.ok(installedExports["cloving/workflows"]?.includes("protectedEffect"));
  assert.ok(
    !installedExports["cloving/workflows"]?.includes("generateWorkflow"),
  );
});

await test("CLV-121 source capability and method checks require actual literals even under assertions", () => {
  for (const [field, dynamic] of [
    ["capability", "input.capability"],
    ["method", "input.method"],
  ] as const) {
    const literal = field === "capability" ? '"claude"' : '"run-turn"';
    for (const value of [
      dynamic,
      `${dynamic} as ${literal}`,
      `${literal} as string`,
    ])
      assert.deepEqual(
        check(
          candidateSource(
            `await ${candidateEffectExpression.replace(`${field}: ${literal}`, `${field}: ${value}`)};`,
          ),
        ),
        ["dynamic-effect"],
        value,
      );
  }
  assert.deepEqual(
    check(validCandidateSource.replace('"run-turn"', '"absent"')),
    ["undeclared-effect"],
  );
  assert.deepEqual(
    check(validCandidateSource.replace('"claude"', '"github"')),
    ["undeclared-effect"],
  );
  assert.deepEqual(
    check(
      validCandidateSource
        .replace("capability:", '"capability":')
        .replace("method:", '"method":'),
    ),
    [],
  );
});

await test("CLV-121 unsupported syntax, helper uses, steps and workflow shapes fail closed", () => {
  for (const [name, source] of Object.entries(unsupportedCandidateSources))
    assert.deepEqual(check(source), ["unsupported-source"], name);
});

await test("CLV-121 a protected helper cannot escape through a shorthand property", () => {
  assert.deepEqual(
    check(candidateSource("const helpers = { protectedEffect };")),
    ["unsupported-source"],
  );
});

for (const [name, source] of [
  [
    "local wrapper",
    `${candidateSource("await invoke(); await invoke();")}\nasync function invoke() { return ${candidateEffectExpression}; }`,
  ],
  [
    "nested wrapper",
    candidateSource(
      `const invoke = async () => ${candidateEffectExpression}; await invoke(); await invoke();`,
    ),
  ],
  [
    "callback",
    candidateSource(
      `await Promise.all([1, 2].map(async () => ${candidateEffectExpression}));`,
    ),
  ],
  [
    "module scope",
    `${candidateSource("return 1;")}\n${candidateEffectExpression};`,
  ],
  [
    "class initializer",
    candidateSource(
      `class Effect { field = ${candidateEffectExpression}; } await new Effect().field; await new Effect().field;`,
    ),
  ],
  [
    "default parameter",
    candidateSource("return 1;").replace(
      "input: { capability: string; method: string; units: number }",
      `input = ${candidateEffectExpression}`,
    ),
  ],
] as const) {
  await test(`CLV-121 refuses a protected call through ${name}`, () => {
    assert.deepEqual(check(source), ["unsupported-source"]);
  });
}

for (const declaration of [
  'type Hidden = import("node:fs").Stats;',
  'type Hidden = typeof import("node:fs");',
]) {
  await test(`CLV-121 rejects dynamic type loading ${declaration}`, () => {
    assert.deepEqual(check(`${validCandidateSource}\n${declaration}`), [
      "unsupported-source",
    ]);
  });
}
