import assert from "node:assert/strict";
import { test } from "node:test";
import { checkWorkflowCandidate } from "../src/workflow-candidate.ts";
import { analyzeWorkflowCandidate } from "./candidate-package-fixture.ts";
import { candidateDeclaration } from "./workflow-candidate-fixtures.ts";

for (const module of ["cloving/workflows", "cloving/workflows/steps/handoff"])
  await test(`CLV-182 installed ${module} admits handoff and counts its effect unit`, () => {
    const source = `import { handoff } from "${module}";
export async function develop(input: { prompt: string }) {
  "use workflow";
  return await handoff({ workflowId: "B", input: input });
}`;
    const facts = analyzeWorkflowCandidate(source);
    const declaration = {
      ...candidateDeclaration,
      workflow: {
        ...candidateDeclaration.workflow,
        effectLimit: 1,
        handoffs: ["B"],
        input: { maximumBytes: 4096, fields: { prompt: { type: "string" } } },
      },
    };
    assert.deepEqual(checkWorkflowCandidate({ declaration, ...facts }), []);
    assert.equal(facts.analysis.knownCallCount, 1);
    assert.equal(facts.analysis.knownUnitTotal, 1);
    const twice = analyzeWorkflowCandidate(
      source.replace(
        "return await",
        'await handoff({ workflowId: "B", input: input }); return await',
      ),
    );
    assert.deepEqual(checkWorkflowCandidate({ declaration, ...twice }), [
      "effect-limit",
    ]);
  });
