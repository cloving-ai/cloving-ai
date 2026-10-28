import assert from "node:assert/strict";
import { test } from "node:test";
import { checkWorkflowCandidate } from "../src/workflow-candidate.ts";
import {
  admitWorkflowCandidate,
  analyzeWorkflowCandidate,
  candidateProgram,
} from "./candidate-package-fixture.ts";
import { candidateDeclaration } from "./workflow-candidate-fixtures.ts";

const declaration = {
  ...candidateDeclaration,
  workflow: { ...candidateDeclaration.workflow, capabilities: ["github"] },
  methods: { github: ["merge"] },
};

const steps = [
  ["mergeWhenGreen", "merge-when-green"],
  ["mergeByPerson", "merge-by-person"],
] as const;

const source = (
  helper: string,
  module: string,
) => `import { ${helper} } from "cloving/workflows/steps/${module}";
import type { MergeResult, PullRequest } from "cloving/workflows";
export async function merge(pull: PullRequest): Promise<MergeResult> {
  "use workflow";
  return await ${helper}({ pull: pull, check: null });
}`;

for (const [helper, module] of steps) {
  await test(`CLV-220 ${helper} compiles and declares one github merge effect`, async () => {
    const text = source(helper, module);
    const typed = candidateProgram(text);
    assert.deepEqual(typed.program.getSemanticDiagnostics(typed.source), []);
    const facts = analyzeWorkflowCandidate(text);
    assert.deepEqual(facts.analysis.effects, [
      { capability: "github", method: "merge" },
    ]);
    assert.equal(facts.analysis.knownUnitTotal, 1);
    assert.deepEqual(checkWorkflowCandidate({ declaration, ...facts }), []);
    const admitted = await admitWorkflowCandidate({
      source: text,
      declaration,
    });
    assert.equal(admitted.kind, "admitted", JSON.stringify(admitted));
  });

  await test(`CLV-220 ${helper} needs the merge method in the declaration`, () => {
    const facts = analyzeWorkflowCandidate(source(helper, module));
    assert.deepEqual(
      checkWorkflowCandidate({
        declaration: { ...declaration, methods: { github: ["wait-review"] } },
        ...facts,
      }),
      ["undeclared-effect"],
    );
  });

  await test(`CLV-220 ${helper} refuses a request with duplicate fields`, () => {
    const facts = analyzeWorkflowCandidate(
      source(helper, module).replace(
        "check: null",
        'check: "beforeMerge", check: null',
      ),
    );
    assert.ok(
      checkWorkflowCandidate({ declaration, ...facts }).includes(
        "unsupported-source",
      ),
    );
  });
}
