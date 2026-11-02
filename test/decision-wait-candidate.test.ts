import assert from "node:assert/strict";
import { test } from "node:test";
import { checkWorkflowCandidate } from "../src/workflow-candidate.ts";
import {
  admitWorkflowCandidate,
  analyzeWorkflowCandidate,
} from "./candidate-package-fixture.ts";
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

for (const module of [
  "cloving/workflows",
  "cloving/workflows/steps/decision-gate",
])
  await test(`CLV-265 admission names the missing decisionGate export from ${module}`, async () => {
    const source = `import { decisionGate } from "${module}";
export async function develop() {
  "use workflow";
  return await decisionGate({ gateId: "review", kind: "approval", prompt: "Approve?" });
}`;
    const facts = analyzeWorkflowCandidate(source);
    assert.deepEqual(facts.analysis.imports, [
      { module, names: ["decisionGate"] },
    ]);
    assert.deepEqual(
      checkWorkflowCandidate({ declaration: candidateDeclaration, ...facts }),
      ["missing-export"],
    );
    assert.deepEqual(
      await admitWorkflowCandidate({
        source,
        declaration: candidateDeclaration,
      }),
      { kind: "refused", codes: ["missing-export"] },
    );
  });
