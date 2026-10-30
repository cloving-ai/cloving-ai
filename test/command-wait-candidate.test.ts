import assert from "node:assert/strict";
import { test } from "node:test";
import { checkWorkflowCandidate } from "../src/workflow-candidate.ts";
import {
  analyzeWorkflowCandidate,
  candidatePackageRoot,
} from "./candidate-package-fixture.ts";
import { analyzeWorkflowCandidate as analyzeInstalled } from "../tools/workflow-candidate-source.ts";
import { candidateDeclaration } from "./workflow-candidate-fixtures.ts";

const declaration = {
  ...candidateDeclaration,
  workflow: {
    ...candidateDeclaration.workflow,
    capabilities: ["command"],
    commands: ["review-state"],
    effectLimit: 1,
    commandWaits: {
      "team-review": {
        command: "review-state",
        maximumWaitSeconds: 2592000,
        pollEverySeconds: 3600,
      },
    },
  },
  methods: { command: ["run:review-state"] },
};
const wait =
  'await waitForCommand({ name: "team-review", input: { change: 42 } })';
const command =
  'await runCommand({ scope: { phase: "prepare", operation: "review", round: 1 }, name: "review-state", input: {} })';
const source = (
  module: string,
  name = '"team-review"',
) => `import { waitForCommand, runCommand } from "cloving/workflows";
import { waitForCommand as wait } from "${module}";
export async function candidate(input) {
  "use workflow";
  ${command};
  await wait({ name: ${name}, input: { change: 42 } });
  return ${wait};
}`;

for (const module of [
  "cloving/workflows",
  "cloving/workflows/steps/wait-for-command",
])
  await test(`CLV-237 candidate admits declared waits through ${module} without adding effects`, () => {
    const facts = analyzeWorkflowCandidate(source(module));
    assert.deepEqual(checkWorkflowCandidate({ declaration, ...facts }), []);
    assert.equal(facts.analysis.knownCallCount, 1);
    assert.equal(facts.analysis.knownUnitTotal, 1);
    for (const [name, expected] of [
      ['"other"', "undeclared-effect"],
      ["input.name", "dynamic-effect"],
      ['"team-" + "review"', "dynamic-effect"],
    ]) {
      const invalid = analyzeWorkflowCandidate(source(module, name));
      assert.deepEqual(checkWorkflowCandidate({ declaration, ...invalid }), [
        expected,
      ]);
    }
  });

await test("CLV-237 local workflow helpers retain ordinary effect totals and declared wait checks", () => {
  const facts = analyzeInstalled(
    `import { review } from "./helpers/review.ts";
export async function candidate() { "use workflow"; await review(); return await review(); }`,
    {
      packageRoot: candidatePackageRoot,
      helpers: {
        "helpers/review.ts": `import { waitForCommand, runCommand } from "cloving/workflows";
export async function review() { ${command}; return ${wait}; }`,
      },
    },
  );
  assert.equal(facts.analysis.knownCallCount, 2);
  assert.equal(facts.analysis.knownUnitTotal, 2);
  assert.deepEqual(checkWorkflowCandidate({ declaration, ...facts }), [
    "effect-limit",
  ]);
});

await test("CLV-237 command wait references, invalid requests and internal host steps cannot bypass admission", () => {
  for (const body of [
    'const invoke = waitForCommand; return await invoke({ name: "team-review", input: {} });',
    'return await waitForCommand({ name: "team-review", input: {}, deadline: 42 });',
    'return await waitForCommand({ name: "team-review", input: {}, callback: () => true });',
  ]) {
    const facts =
      analyzeWorkflowCandidate(`import { waitForCommand } from "cloving/workflows";
export async function candidate() { "use workflow"; ${body} }`);
    assert.ok(
      checkWorkflowCandidate({ declaration, ...facts }).includes(
        "unsupported-source",
      ),
    );
  }
  const internal = analyzeWorkflowCandidate(
    'import { checkCommandWait } from "cloving/workflows/steps/command-wait"; export async function candidate() { "use workflow"; return await checkCommandWait({ name: "team-review" }); }',
  );
  assert.ok(
    checkWorkflowCandidate({ declaration, ...internal }).includes(
      "forbidden-import",
    ),
  );
});
