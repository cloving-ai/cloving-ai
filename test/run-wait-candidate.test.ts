import assert from "node:assert/strict";
import { test } from "node:test";
import { checkWorkflowCandidate } from "../src/workflow-candidate.ts";
import { analyzeWorkflowCandidate } from "./candidate-package-fixture.ts";
import { candidateDeclaration } from "./workflow-candidate-fixtures.ts";

for (const module of [
  "cloving/workflows",
  "cloving/workflows/steps/wait-for-run",
])
  await test(`CLV-180 installed ${module} admits waitForRun without an effect unit`, () => {
    const facts =
      analyzeWorkflowCandidate(`import { waitForRun } from "${module}";
export async function develop(input: { runId: string }) {
  "use workflow";
  return await waitForRun({ runId: input.runId, maximumWaitSeconds: 60 });
}`);
    assert.deepEqual(
      checkWorkflowCandidate({ declaration: candidateDeclaration, ...facts }),
      [],
    );
    assert.equal(facts.analysis.knownCallCount, 0);
    assert.equal(facts.analysis.knownUnitTotal, 0);
  });
