import assert from "node:assert/strict";
import { test } from "node:test";
import {
  candidateDeclarationRefusals,
  checkWorkflowCandidate,
} from "../src/workflow-candidate.ts";
import {
  candidateDeclaration,
  installedWorkflowExports,
  validCandidateAnalysis,
  validCandidateSource,
} from "./workflow-candidate-fixtures.ts";
import { loadWorkflowFolders } from "./candidate-package-fixture.ts";
import { folderInput } from "./workflow-folder-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";
import { workflowRefusals } from "../src/workflow-refusals.ts";
import {
  handoffChain,
  type RunOrigin,
} from "../src/authority/handoff-chain.ts";
import { operationOf } from "./effect-fixture.ts";

const limited = (workflow: Readonly<Record<string, unknown>>) => ({
  ...candidateDeclaration,
  workflow: { ...candidateDeclaration.workflow, ...workflow },
});

await test("CLV-308 an effect limit of 150 registers under an operator maximum of 200 and is refused under the default", () => {
  const declaration = limited({ effectLimit: 150 });
  assert.deepEqual(
    candidateDeclarationRefusals(declaration, { effects: 200, chain: 5 }),
    [],
  );
  assert.deepEqual(candidateDeclarationRefusals(declaration), [
    "effect-limit-above-maximum",
  ]);
  assert.deepEqual(
    checkWorkflowCandidate({
      declaration,
      analysis: validCandidateAnalysis,
      installedExports: installedWorkflowExports,
      limits: { effects: 200, chain: 5 },
    }),
    [],
  );
  assert.deepEqual(
    checkWorkflowCandidate({
      declaration,
      analysis: validCandidateAnalysis,
      installedExports: installedWorkflowExports,
    }),
    ["effect-limit-above-maximum"],
  );
});

await test("CLV-308 an effect limit above the largest operator maximum is not a valid declaration", () => {
  assert.deepEqual(
    candidateDeclarationRefusals(limited({ effectLimit: 1001 }), {
      effects: 1000,
      chain: 50,
    }),
    ["invalid-declaration"],
  );
});

await test("CLV-308 the folder loader refuses an effect limit above the operator maximum and admits it under a raised maximum", () =>
  withFiles(
    {
      "repo/marker": "",
      "config/cloving/workflows/candidate.ts": validCandidateSource,
      "config/cloving/workflows/candidate.declaration.json": JSON.stringify(
        limited({ effectLimit: 150 }),
      ),
    },
    async (directory) => {
      const refused = await loadWorkflowFolders(folderInput(directory));
      assert.deepEqual(refused.refusals, [
        {
          scope: "user",
          label: "candidate.ts",
          codes: ["effect-limit-above-maximum"],
        },
      ]);
      const raised = await loadWorkflowFolders({
        ...folderInput(directory),
        limits: { effects: 200, chain: 5 },
      });
      assert.deepEqual(raised.refusals, []);
      assert.deepEqual(
        raised.candidates.map((entry) => entry.label),
        ["candidate.ts"],
      );
    },
  ));

await test("CLV-308 the workflow inventory keeps a refusal for an effect limit above the operator maximum", () => {
  const refusal = {
    scope: "user",
    label: "candidate.ts",
    codes: ["effect-limit-above-maximum"],
  };
  assert.deepEqual(workflowRefusals([refusal]), [refusal]);
});

await test("CLV-308 a chain limit of 8 registers under an operator maximum of 10 and is refused under the default", () => {
  const declaration = limited({ chainLimit: 8 });
  assert.deepEqual(
    candidateDeclarationRefusals(declaration, { effects: 100, chain: 10 }),
    [],
  );
  assert.deepEqual(candidateDeclarationRefusals(declaration), [
    "chain-limit-above-maximum",
  ]);
  assert.deepEqual(
    workflowRefusals([
      {
        scope: "project",
        label: "candidate.ts",
        codes: ["chain-limit-above-maximum"],
      },
    ]).length,
    1,
  );
  for (const chainLimit of [1, 51, 2.5, "8", null])
    assert.deepEqual(
      candidateDeclarationRefusals(limited({ chainLimit }), {
        effects: 100,
        chain: 50,
      }),
      ["invalid-declaration"],
    );
});

await test("CLV-308 the first run of a chain decides the chain limit for every handoff", () => {
  const origins: Record<string, RunOrigin> = {
    "run-1": { parentRunId: null, chainId: "run-1", chainLimit: 8 },
  };
  for (let depth = 2; depth <= 8; depth += 1)
    origins[`run-${String(depth)}`] = {
      parentRunId: `run-${String(depth - 1)}`,
      chainId: "run-1",
    };
  const handoff = (parent: string) =>
    handoffChain(`handoff:${operationOf(parent, { round: 1 })}`, origins);
  assert.deepEqual(handoff("run-7"), {
    kind: "handoff",
    parentRunId: "run-7",
    chainId: "run-1",
  });
  assert.deepEqual(handoff("run-8"), {
    kind: "refused",
    reason: "chain-limit",
  });
  const unlimited = {
    ...origins,
    "run-1": { parentRunId: null, chainId: "run-1" },
  };
  assert.deepEqual(
    handoffChain(`handoff:${operationOf("run-5", { round: 1 })}`, unlimited),
    { kind: "refused", reason: "chain-limit" },
  );
});
