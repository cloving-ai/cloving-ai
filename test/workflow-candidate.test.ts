import assert from "node:assert/strict";
import { test } from "node:test";
import { checkWorkflowCandidate } from "../src/workflow-candidate.ts";
import type { CandidateAnalysis } from "../src/workflow-candidate.ts";
import {
  candidateDeclaration,
  combinedCandidateAnalysis,
  directEffectCategories,
  forbiddenCandidateModules,
  invalidCandidateDeclarations,
  installedWorkflowExports,
  unsupportedCandidateForms,
  validCandidateAnalysis,
} from "./workflow-candidate-fixtures.ts";

function check(
  analysis: CandidateAnalysis,
  declaration: unknown = candidateDeclaration,
) {
  return checkWorkflowCandidate({
    declaration,
    analysis,
    installedExports: installedWorkflowExports,
  });
}

await test("CLV-121 pure policy reports both combined refusal codes deterministically without changing its data", () => {
  const input = {
    declaration: candidateDeclaration,
    analysis: combinedCandidateAnalysis,
    installedExports: installedWorkflowExports,
  };
  const before = JSON.stringify(input);
  assert.deepEqual(checkWorkflowCandidate(input), [
    "missing-export",
    "undeclared-effect",
  ]);
  assert.deepEqual(checkWorkflowCandidate(input), [
    "missing-export",
    "undeclared-effect",
  ]);
  assert.equal(JSON.stringify(input), before);
});

await test("CLV-121 invalid workflow declarations and malformed capability method maps are refused", () => {
  for (const declaration of invalidCandidateDeclarations)
    assert.deepEqual(check(validCandidateAnalysis, declaration), [
      "invalid-declaration",
    ]);
});

await test("CLV-121 a sparse method list is an invalid declaration before and after serialization", () => {
  const methods: string[] = [];
  methods.length = 1;
  const declaration = { ...candidateDeclaration, methods: { claude: methods } };
  assert.deepEqual(check(validCandidateAnalysis, declaration), [
    "invalid-declaration",
  ]);
  const serialized: unknown = JSON.parse(JSON.stringify(declaration));
  assert.deepEqual(check(validCandidateAnalysis, serialized), [
    "invalid-declaration",
  ]);
});

await test("CLV-121 valid serializable facts have no refusal codes and do not constitute admission", () => {
  assert.deepEqual(check(validCandidateAnalysis), []);
  const declaration = {
    workflow: {
      ...candidateDeclaration.workflow,
      capabilities: ["claude", "github"],
    },
    methods: {
      claude: ["run-turn", "inspect"],
      github: ["create-pull-request"],
    },
  };
  assert.deepEqual(check(validCandidateAnalysis, declaration), []);
});

await test("CLV-121 only the four installed workflow subpaths may supply named imports", () => {
  for (const module of forbiddenCandidateModules)
    assert.deepEqual(
      check({
        ...validCandidateAnalysis,
        imports: [{ module, names: ["helper"] }],
      }),
      ["forbidden-import"],
      module,
    );
});

await test("CLV-121 supplied export data cannot widen the permitted module boundary", () => {
  assert.deepEqual(
    checkWorkflowCandidate({
      declaration: candidateDeclaration,
      analysis: {
        ...validCandidateAnalysis,
        imports: [{ module: "node:fs", names: ["readFile"] }],
      },
      installedExports: { "node:fs": ["readFile"] },
    }),
    ["forbidden-import"],
  );
});

await test("CLV-121 missing named values and types share one missing-export code", () => {
  for (const name of ["AbsentValue", "AbsentType"])
    assert.deepEqual(
      check({
        ...validCandidateAnalysis,
        imports: [{ module: "cloving/workflows", names: [name, name] }],
      }),
      ["missing-export"],
    );
  assert.deepEqual(
    checkWorkflowCandidate({
      declaration: candidateDeclaration,
      analysis: validCandidateAnalysis,
      installedExports: {},
    }),
    ["missing-export"],
  );
});

await test("CLV-121 every installed subpath can supply its declared names including types", () => {
  assert.deepEqual(
    check({
      ...validCandidateAnalysis,
      imports: Object.entries(installedWorkflowExports).map(
        ([module, names]) => ({
          module,
          names,
        }),
      ),
    }),
    [],
  );
});

await test("CLV-121 absent capabilities and methods are undeclared effects including prototype names", () => {
  for (const capability of [
    "github",
    "unknown",
    "__proto__",
    "constructor",
    "toString",
  ])
    assert.deepEqual(
      check({
        ...validCandidateAnalysis,
        effects: [{ capability, method: "run-turn" }],
      }),
      ["undeclared-effect"],
      capability,
    );
  assert.deepEqual(
    check({
      ...validCandidateAnalysis,
      effects: [{ capability: "claude", method: "create-pull-request" }],
    }),
    ["undeclared-effect"],
  );
});

await test("CLV-121 a capability or method without a proven literal is a dynamic effect", () => {
  for (const effect of [
    { capability: null, method: "run-turn" },
    { capability: "claude", method: null },
    { capability: null, method: null },
  ])
    assert.deepEqual(check({ ...validCandidateAnalysis, effects: [effect] }), [
      "dynamic-effect",
    ]);
});

await test("CLV-121 known call counts or unit totals exceeding the declaration limit are refused", () => {
  for (const totals of [
    { knownCallCount: 2, knownUnitTotal: 1 },
    { knownCallCount: 1, knownUnitTotal: 2 },
    { knownCallCount: 2, knownUnitTotal: 2 },
  ])
    assert.deepEqual(check({ ...validCandidateAnalysis, ...totals }), [
      "effect-limit",
    ]);
});

await test("CLV-121 exact-limit counts pass and unknown remaining units are not a static proof", () => {
  const declaration = {
    ...candidateDeclaration,
    workflow: { ...candidateDeclaration.workflow, effectLimit: 3 },
  };
  assert.deepEqual(
    check(
      { ...validCandidateAnalysis, knownCallCount: 3, knownUnitTotal: 3 },
      declaration,
    ),
    [],
  );
  assert.deepEqual(check({ ...validCandidateAnalysis, knownUnitTotal: 0 }), []);
});

await test("CLV-121 invalid static count facts fail closed as unsupported source", () => {
  for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.deepEqual(
      check({ ...validCandidateAnalysis, knownCallCount: value }),
      ["unsupported-source"],
    );
    assert.deepEqual(
      check({ ...validCandidateAnalysis, knownUnitTotal: value }),
      ["unsupported-source"],
    );
  }
});

await test("CLV-121 every supplied direct-effect category is refused", () => {
  for (const category of directEffectCategories)
    assert.deepEqual(
      check({ ...validCandidateAnalysis, directEffects: [category, category] }),
      ["direct-effect"],
      category,
    );
});

await test("CLV-121 unsupported syntax and symbol forms fail closed", () => {
  for (const form of unsupportedCandidateForms)
    assert.deepEqual(
      check({ ...validCandidateAnalysis, unsupportedForms: [form, form] }),
      ["unsupported-source"],
      form,
    );
});

await test("CLV-121 independent findings are unique and sorted regardless of fact ordering", () => {
  const analysis: CandidateAnalysis = {
    ...combinedCandidateAnalysis,
    imports: [
      ...combinedCandidateAnalysis.imports,
      { module: "node:fs", names: ["readFile"] },
      ...combinedCandidateAnalysis.imports,
    ],
    effects: [
      ...combinedCandidateAnalysis.effects,
      { capability: null, method: null },
      ...combinedCandidateAnalysis.effects,
    ],
    directEffects: directEffectCategories,
    unsupportedForms: unsupportedCandidateForms,
    knownCallCount: 3,
    knownUnitTotal: 3,
  };
  const expected = [
    "direct-effect",
    "dynamic-effect",
    "effect-limit",
    "forbidden-import",
    "missing-export",
    "undeclared-effect",
    "unsupported-source",
  ];
  assert.deepEqual(check(analysis), expected);
  assert.deepEqual(
    check({
      ...analysis,
      imports: analysis.imports.toReversed(),
      effects: analysis.effects.toReversed(),
      directEffects: analysis.directEffects.toReversed(),
      unsupportedForms: analysis.unsupportedForms.toReversed(),
    }),
    expected,
  );
  assert.deepEqual(
    check({
      ...validCandidateAnalysis,
      knownUnitTotal: -1,
      unsupportedForms: ["spread"],
    }),
    ["unsupported-source"],
  );
});
