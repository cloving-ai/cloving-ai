import assert from "node:assert/strict";
import { test } from "node:test";
import { checkWorkflowCandidate } from "../src/workflow-candidate.ts";
import { analyzeWorkflowCandidate } from "./candidate-package-fixture.ts";
import { candidateDeclaration } from "./workflow-candidate-fixtures.ts";
import {
  pollingWorkflow,
  pollingDeclaration as declaration,
} from "./command-polling-fixture.ts";

for (const module of ["cloving/workflows/steps/sleep", "cloving/workflows"])
  await test(`CLV-233 ${module} admits sleep without effects or units`, () => {
    const facts = analyzeWorkflowCandidate(`import { sleep } from "${module}";
export async function develop() {
  "use workflow";
  await sleep({ seconds: 60 });
}`);
    assert.deepEqual(
      checkWorkflowCandidate({ declaration: candidateDeclaration, ...facts }),
      [],
    );
    assert.deepEqual(facts.analysis.effects, []);
    assert.equal(facts.analysis.knownCallCount, 0);
    assert.equal(facts.analysis.knownUnitTotal, 0);
  });

await test("CLV-233 sleep preserves command accounting in fixed and early-exit loops", () => {
  const facts = analyzeWorkflowCandidate(pollingWorkflow);
  assert.deepEqual(checkWorkflowCandidate({ declaration, ...facts }), []);
  assert.equal(facts.analysis.knownCallCount, 1);
  assert.equal(facts.analysis.knownUnitTotal, 1);
  const fixed =
    analyzeWorkflowCandidate(`import { runCommand, sleep } from "cloving/workflows";
export async function approval() {
  "use workflow";
  for (let round = 1; round <= 3; round += 1) {
    await runCommand({ scope: { phase: "approval", operation: "check", round }, name: "approval-status", input: {} });
    await sleep({ seconds: 60 });
  }
}`);
  assert.equal(fixed.analysis.knownCallCount, 3);
  assert.equal(fixed.analysis.knownUnitTotal, 3);
  for (const [effectLimit, codes] of [
    [2, ["effect-limit"]],
    [3, []],
  ] as const)
    assert.deepEqual(
      checkWorkflowCandidate({
        ...fixed,
        declaration: {
          ...declaration,
          workflow: { ...declaration.workflow, effectLimit },
        },
      }),
      codes,
    );
});

await test("CLV-233 sleep does not admit raw SDK imports or direct effects", () => {
  for (const source of [
    'import { sleep } from "workflow"; export async function approval() { "use workflow"; await sleep(1000); }',
    'import { sleep } from "cloving/workflows"; export async function approval() { "use workflow"; await sleep({seconds:1}); await fetch("https://example.invalid"); }',
    'import { exec } from "node:child_process"; export async function approval() { "use workflow"; exec("true"); }',
  ])
    assert.ok(
      checkWorkflowCandidate({
        declaration,
        ...analyzeWorkflowCandidate(source),
      }).length > 0,
    );
});
