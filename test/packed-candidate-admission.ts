import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  candidateDeclaration,
  candidateEffectExpression,
  candidateSource,
  combinedCandidateSource,
  validCandidateSource,
} from "./workflow-candidate-fixtures.ts";

export async function packedCandidateAdmission(root: string): Promise<void> {
  await writeFile(
    join(root, "candidate-admission.mjs"),
    `
import assert from "node:assert/strict";
import { admitWorkflowCandidate } from "./node_modules/cloving/dist/tools/admit-workflow.js";
const declaration = ${JSON.stringify(candidateDeclaration)};
const admitted = await admitWorkflowCandidate({ source: ${JSON.stringify(validCandidateSource)}, declaration });
assert.equal(admitted.kind, "admitted");
assert.match(admitted.artifactDigest, /^[0-9a-f]{64}$/);
assert.deepEqual(await admitWorkflowCandidate({ source: ${JSON.stringify(combinedCandidateSource)}, declaration }), { kind: "refused", codes: ["missing-export", "undeclared-effect"] });
assert.deepEqual(await admitWorkflowCandidate({ source: ${JSON.stringify(`process.exit(99);\n${validCandidateSource}`)}, declaration }), { kind: "refused", codes: ["direct-effect"] });
assert.deepEqual(await admitWorkflowCandidate({ source: ${JSON.stringify(`Math.valueOf().random();\n${validCandidateSource}`)}, declaration }), { kind: "refused", codes: ["direct-effect"] });
const earlyExit = await admitWorkflowCandidate({ source: ${JSON.stringify(candidateSource(`for (let index = 0; index < 3; index++) { await ${candidateEffectExpression}; break; }`).replace('"cloving/workflows"', '"cloving/workflows/steps/protected-effect"'))}, declaration });
assert.equal(earlyExit.kind, "admitted");
const commandSource = ${JSON.stringify(`import { runCommand } from "cloving/workflows/steps/run-command";
export async function scan() {
  "use workflow";
  return await runCommand({ scope: { phase: "scan", operation: "reviews", round: 1 }, name: "review-requests", input: {} });
}`)};
const commandDeclaration = { workflow: { ...declaration.workflow, capabilities: ["command"], commands: ["review-requests"] }, methods: { command: ["run:review-requests"] } };
const command = await admitWorkflowCandidate({ source: commandSource, declaration: commandDeclaration });
assert.equal(command.kind, "admitted", JSON.stringify(command));
assert.match(command.artifactDigest, /^[0-9a-f]{64}$/);
process.stdout.write("candidate-admission-ok");
`,
  );
  assert.equal(
    execFileSync(
      process.execPath,
      ["--no-strip-types", "candidate-admission.mjs"],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 120000,
        maxBuffer: 4 * 1024 * 1024,
      },
    ),
    "candidate-admission-ok",
  );
}
