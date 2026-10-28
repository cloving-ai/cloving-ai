import assert from "node:assert/strict";
import { test } from "node:test";
import { checkWorkflowCandidate } from "../src/workflow-candidate.ts";
import {
  admitWorkflowCandidate,
  analyzeWorkflowCandidate,
  candidateProgram,
  loadWorkflowFolders,
} from "./candidate-package-fixture.ts";
import { candidateDeclaration } from "./workflow-candidate-fixtures.ts";
import { folderInput } from "./workflow-folder-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";

const declaration = {
  ...candidateDeclaration,
  workflow: { ...candidateDeclaration.workflow, capabilities: ["github"] },
  methods: { github: ["wait-review"] },
};

const source = (
  module: string,
  helper = "reviewByAgent",
) => `import { ${helper} } from "${module}";
import type { ReviewResult, ReviewSubject } from "cloving/workflows";
export async function review(subject: ReviewSubject): Promise<ReviewResult> {
  "use workflow";
  return await ${helper}({ subject: subject${helper === "reviewByAgent" ? ', reviewer: { kind: "greptile" }' : ""} });
}`;

const turnSource = source("cloving/workflows/steps/review-by-agent").replace(
  'kind: "greptile"',
  'kind: "turn", profile: "checker"',
);
const turnDeclaration = {
  ...declaration,
  workflow: { ...declaration.workflow, capabilities: ["claude"] },
  methods: { claude: ["run-turn:checker"] },
};

await test("CLV-220 named turn review compiles with the person result and declares its protected effect", async () => {
  for (const text of [
    turnSource,
    source("cloving/workflows/steps/review-by-person", "reviewByPerson"),
  ]) {
    const typed = candidateProgram(text);
    assert.deepEqual(typed.program.getSemanticDiagnostics(typed.source), []);
  }
  const facts = analyzeWorkflowCandidate(turnSource);
  assert.deepEqual(facts.analysis.effects, [
    { capability: "claude", method: "run-turn:checker" },
  ]);
  assert.equal(facts.analysis.knownCallCount, 1);
  assert.equal(facts.analysis.knownUnitTotal, 1);
  assert.deepEqual(
    checkWorkflowCandidate({ declaration: turnDeclaration, ...facts }),
    [],
  );
  const admitted = await admitWorkflowCandidate({
    source: turnSource,
    declaration: turnDeclaration,
  });
  assert.equal(admitted.kind, "admitted", JSON.stringify(admitted));
});

await test("CLV-220 turn review admission retains method and budget checks", () => {
  const facts = analyzeWorkflowCandidate(turnSource);
  for (const candidate of [
    { ...turnDeclaration, methods: { claude: ["run-turn:fixer"] } },
    declaration,
  ])
    assert.deepEqual(
      checkWorkflowCandidate({
        declaration: candidate,
        ...facts,
      }),
      ["undeclared-effect"],
    );
  const repeated = analyzeWorkflowCandidate(
    turnSource.replace(
      "  return await",
      '  await reviewByAgent({ subject: subject, reviewer: { kind: "turn", profile: "checker" } });\n  return await',
    ),
  );
  assert.equal(repeated.analysis.knownUnitTotal, 2);
  assert.deepEqual(
    checkWorkflowCandidate({ declaration: turnDeclaration, ...repeated }),
    ["effect-limit"],
  );
});

for (const module of [
  "cloving/workflows",
  "cloving/workflows/steps/review-by-agent",
])
  await test(`CLV-220 both review calls compile with the same result from ${module}`, async () => {
    const agent = source(module);
    const person = source(
      "cloving/workflows/steps/review-by-person",
      "reviewByPerson",
    );
    for (const text of [agent, person]) {
      const typed = candidateProgram(text);
      assert.deepEqual(typed.program.getSemanticDiagnostics(typed.source), []);
    }
    const facts = analyzeWorkflowCandidate(agent);
    assert.deepEqual(facts.analysis.effects, [
      { capability: "github", method: "wait-review" },
    ]);
    assert.equal(facts.analysis.knownCallCount, 1);
    assert.equal(facts.analysis.knownUnitTotal, 1);
    assert.deepEqual(checkWorkflowCandidate({ declaration, ...facts }), []);
    const admitted = await admitWorkflowCandidate({
      source: agent,
      declaration,
    });
    assert.equal(admitted.kind, "admitted", JSON.stringify(admitted));
  });

await test("CLV-220 Greptile calls cannot bypass declared methods or effect totals", () => {
  const text = source("cloving/workflows/steps/review-by-agent");
  const facts = analyzeWorkflowCandidate(text);
  assert.deepEqual(
    checkWorkflowCandidate({ declaration: candidateDeclaration, ...facts }),
    ["undeclared-effect"],
  );
  assert.deepEqual(
    checkWorkflowCandidate({
      declaration: { ...declaration, methods: { github: ["open-pr"] } },
      ...facts,
    }),
    ["undeclared-effect"],
  );
  const repeated = analyzeWorkflowCandidate(
    text.replace(
      "  return await",
      '  await reviewByAgent({ subject: subject, reviewer: { kind: "greptile" } });\n  return await',
    ),
  );
  assert.equal(repeated.analysis.knownCallCount, 2);
  assert.equal(repeated.analysis.knownUnitTotal, 2);
  assert.deepEqual(checkWorkflowCandidate({ declaration, ...repeated }), [
    "effect-limit",
  ]);
});

for (const replacement of [
  'const invoke = reviewByAgent; return await invoke({ subject: subject, reviewer: { kind: "greptile" } });',
  "return await reviewByAgent({ subject: subject, reviewer: subject });",
  'return await reviewByAgent({ subject: subject, reviewer: { kind: "turn" } });',
])
  await test(`CLV-220 agent review admission rejects unchecked calls ${replacement}`, () => {
    const text = source("cloving/workflows/steps/review-by-agent").replace(
      'return await reviewByAgent({ subject: subject, reviewer: { kind: "greptile" } });',
      replacement,
    );
    const facts = analyzeWorkflowCandidate(text);
    assert.ok(checkWorkflowCandidate({ declaration, ...facts }).length > 0);
  });

await test("CLV-220 a folder review cannot call an undeclared GitHub method", () =>
  withFiles(
    {
      "repo/.cloving/workflows/review.ts": source(
        "cloving/workflows/steps/review-by-agent",
      ),
      "repo/.cloving/workflows/review.declaration.json": JSON.stringify({
        ...declaration,
        workflow: { ...declaration.workflow, workflowId: "review" },
        methods: { github: ["open-pr"] },
      }),
    },
    async (directory) => {
      const result = await loadWorkflowFolders(folderInput(directory));
      assert.deepEqual(result.candidates, []);
      assert.deepEqual(result.refusals[0]?.codes, ["undeclared-effect"]);
    },
  ));

for (const candidate of [
  { ...turnDeclaration, methods: { claude: ["run-turn:fixer"] } },
  declaration,
])
  await test(`CLV-220 folder turn review refuses undeclared capability or profile ${JSON.stringify(candidate.methods)}`, () =>
    withFiles(
      {
        "repo/.cloving/workflows/review.ts": turnSource,
        "repo/.cloving/workflows/review.declaration.json": JSON.stringify({
          ...candidate,
          workflow: { ...candidate.workflow, workflowId: "review" },
        }),
      },
      async (directory) => {
        const result = await loadWorkflowFolders(folderInput(directory));
        assert.deepEqual(result.candidates, []);
        assert.deepEqual(result.refusals[0]?.codes, ["undeclared-effect"]);
      },
    ));

for (const profile of ["subject.target", '""', '"bad.profile"'])
  await test(`CLV-220 turn review admission refuses a dynamic or invalid profile ${profile}`, () => {
    const facts = analyzeWorkflowCandidate(
      turnSource.replace('profile: "checker"', `profile: ${profile}`),
    );
    assert.ok(
      checkWorkflowCandidate({
        declaration: turnDeclaration,
        ...facts,
      }).includes("dynamic-effect"),
    );
  });

for (const reviewer of [
  'kind: "turn", profile: "checker", profile: "fixer"',
  'kind: "greptile", kind: "turn", profile: "checker"',
])
  await test(`CLV-220 turn review admission refuses duplicate reviewer fields ${reviewer}`, () => {
    const facts = analyzeWorkflowCandidate(
      turnSource.replace('kind: "turn", profile: "checker"', reviewer),
    );
    assert.ok(
      checkWorkflowCandidate({
        declaration: {
          ...turnDeclaration,
          methods: { claude: ["run-turn:checker", "run-turn:fixer"] },
        },
        ...facts,
      }).includes("unsupported-source"),
    );
  });
