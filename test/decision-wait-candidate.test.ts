import assert from "node:assert/strict";
import { test } from "node:test";
import { checkWorkflowCandidate } from "../src/workflow-candidate.ts";
import { analyzeWorkflowCandidate } from "./candidate-package-fixture.ts";
import { candidateDeclaration } from "./workflow-candidate-fixtures.ts";

for (const module of [
  "cloving/workflows",
  "cloving/workflows/steps/wait-for-decision",
])
  await test(`CLV-219 folder workflows import waitForDecision from ${module}`, () => {
    const facts =
      analyzeWorkflowCandidate(`import { waitForDecision } from "${module}";
export async function develop() {
  "use workflow";
  return await waitForDecision({ gateId: "review", kind: "approval", prompt: "Approve?" });
}`);
    assert.deepEqual(
      checkWorkflowCandidate({ declaration: candidateDeclaration, ...facts }),
      [],
    );
    assert.equal(facts.analysis.knownCallCount, 0);
  });
