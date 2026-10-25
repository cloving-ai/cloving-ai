import assert from "node:assert/strict";
import { test } from "node:test";
import { checkWorkflowCandidate } from "../src/workflow-candidate.ts";
import { analyzeWorkflowCandidate } from "./candidate-package-fixture.ts";
import { candidateDeclaration } from "./workflow-candidate-fixtures.ts";

const declaration = {
  ...candidateDeclaration,
  workflow: {
    ...candidateDeclaration.workflow,
    capabilities: ["command"],
    commands: ["review-requests"],
    effectLimit: 1,
  },
  methods: { command: ["run:review-requests"] },
};
const expression =
  'runCommand({ scope: { phase: "scan", operation: "reviews", round: 1 }, name: "review-requests", input: {} })';
const source = (module: string, body = `return await ${expression};`) =>
  `import { runCommand } from "${module}";
export async function candidate() {
  "use workflow";
  ${body}
}`;

for (const module of [
  "cloving/workflows",
  "cloving/workflows/steps/run-command",
]) {
  await test(`CLV-178 installed ${module} identifies and counts a command effect`, () => {
    const facts = analyzeWorkflowCandidate(source(module));
    assert.deepEqual(facts.analysis.effects, [
      { capability: "command", method: "run:review-requests" },
    ]);
    assert.equal(facts.analysis.knownCallCount, 1);
    assert.equal(facts.analysis.knownUnitTotal, 1);
    assert.deepEqual(checkWorkflowCandidate({ declaration, ...facts }), []);
  });
}

await test("CLV-178 command helper calls cannot bypass candidate effect bounds or method declarations", () => {
  const twice = analyzeWorkflowCandidate(
    source(
      "cloving/workflows",
      `await ${expression}; return await ${expression};`,
    ),
  );
  assert.deepEqual(checkWorkflowCandidate({ declaration, ...twice }), [
    "effect-limit",
  ]);
  const unknown = analyzeWorkflowCandidate(
    source("cloving/workflows").replace(
      'name: "review-requests"',
      'name: "other"',
    ),
  );
  assert.deepEqual(checkWorkflowCandidate({ declaration, ...unknown }), [
    "undeclared-effect",
  ]);
});

await test("CLV-178 candidate command names must be literal and helper references cannot escape", () => {
  const dynamic = analyzeWorkflowCandidate(
    source("cloving/workflows").replace(
      'name: "review-requests"',
      'name: "review-" + "requests"',
    ),
  );
  assert.deepEqual(checkWorkflowCandidate({ declaration, ...dynamic }), [
    "dynamic-effect",
  ]);
  const escaped = analyzeWorkflowCandidate(
    source(
      "cloving/workflows",
      "const call = runCommand; return await call({});",
    ),
  );
  assert.ok(
    checkWorkflowCandidate({ declaration, ...escaped }).includes(
      "unsupported-source",
    ),
  );
});
