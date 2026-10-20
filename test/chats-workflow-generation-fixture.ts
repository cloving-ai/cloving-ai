import assert from "node:assert/strict";
import { validateAnalysis } from "../src/chats/analysis.ts";
import type { WorkflowGenerationAvailability } from "../src/chats/workflow-generation.ts";
import { candidate, records, structure } from "./chats-analysis-fixture.ts";

export function acceptedAnalysis(input = candidate()) {
  const validation = validateAnalysis(input, { records, structure });
  assert.equal(validation.accepted, true);
  return validation.result;
}

export const generationAvailability: WorkflowGenerationAvailability = {
  exports: {
    "cloving/workflows": ["CycleOutcome", "ProtectedResult"],
    "cloving/workflows/steps/protected-effect": ["protectedEffect"],
    "cloving/workflows/steps/decision-gate": ["decisionGate"],
  },
  methods: { claude: ["run-turn"] },
};
