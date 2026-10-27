import assert from "node:assert/strict";
import { test } from "node:test";
import { checkWorkflowCandidate } from "../src/workflow-candidate.ts";
import {
  admitWorkflowCandidate,
  analyzeWorkflowCandidate,
  candidateProgram,
} from "./candidate-package-fixture.ts";
import { candidateDeclaration } from "./workflow-candidate-fixtures.ts";

const source = (module: string) => `import { reviewByPerson } from "${module}";
import type { ReviewResult } from "cloving/workflows";
export async function review(): Promise<ReviewResult> {
  "use workflow";
  return await reviewByPerson({ subject: { draft: "A draft for review." } });
}`;

for (const module of [
  "cloving/workflows",
  "cloving/workflows/steps/review-by-person",
])
  await test(`CLV-220 person reviews compile from ${module} without protected effects`, async () => {
    const facts = analyzeWorkflowCandidate(source(module));
    assert.deepEqual(
      checkWorkflowCandidate({ declaration: candidateDeclaration, ...facts }),
      [],
    );
    assert.deepEqual(facts.analysis.effects, []);
    assert.equal(facts.analysis.knownCallCount, 0);
    assert.equal(facts.analysis.knownUnitTotal, 0);
    const typed = candidateProgram(source(module));
    assert.deepEqual(typed.program.getSemanticDiagnostics(typed.source), []);
    const admitted = await admitWorkflowCandidate({
      source: source(module),
      declaration: candidateDeclaration,
    });
    assert.equal(admitted.kind, "admitted", JSON.stringify(admitted));
  });
