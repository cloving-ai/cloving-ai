import assert from "node:assert/strict";
import {
  validateAnalysis,
  type AnalysisCandidate,
  type AnalysisItem,
} from "../src/chats/analysis.ts";
import {
  candidate as fullCandidate,
  itemAt,
  records,
  ref,
  structure,
} from "./chats-analysis-fixture.ts";

export const evidence = { records, structure };

export function batch(sourceRefs = [ref(1)]): AnalysisCandidate {
  return {
    schemaVersion: 1,
    process: {
      id: "process",
      name: "Synthetic process",
      scope: "Historical evidence only.",
      inputs: [{ id: "input", description: "Input." }],
      stages: [
        {
          id: "review",
          description: "Review.",
          kind: "assistant-claim",
          activity: "work",
          sourceRefs,
          counterevidenceRefs: [],
        },
      ],
      branches: [],
      loops: [],
      artifacts: [],
      stoppingConditions: [{ id: "stop", description: "Stop." }],
      gates: [],
      nonGates: [],
    },
  };
}

export function accepted(candidate: unknown = batch()) {
  const validation = validateAnalysis(candidate, evidence);
  assert.ok(validation.accepted);
  return validation.result;
}

export function questionBatch() {
  const base = batch();
  return {
    ...base,
    process: {
      ...base.process,
      stages: [
        { ...itemAt(base.process.stages), counterevidenceRefs: [ref(2)] },
      ],
    },
    openQuestion: {
      claimId: "review",
      description: "Which interpretation?",
      sourceRefs: [ref(1), ref(2)],
      choices: [
        { id: "first", description: "First." },
        { id: "second", description: "Second." },
      ],
    },
  };
}

function additional<T extends AnalysisItem>(
  items: readonly T[],
  id: string,
): T[] {
  return [...items, { ...itemAt(items), id }];
}

export function extendedBatch() {
  const candidate = fullCandidate();
  const process = candidate.process;
  return {
    ...candidate,
    process: {
      ...process,
      inputs: additional(process.inputs, "extra-input"),
      stages: [
        ...additional(process.stages, "extra-stage"),
        { ...itemAt(process.stages, 1), id: "extra-repair" },
      ],
      branches: additional(process.branches, "extra-branch"),
      loops: additional(process.loops, "extra-loop"),
      artifacts: additional(process.artifacts, "extra-artifact"),
      stoppingConditions: additional(process.stoppingConditions, "extra-stop"),
      gates: additional(process.gates, "extra-gate"),
      nonGates: [
        ...process.nonGates,
        {
          ...itemAt(process.nonGates),
          id: "extra-non-gate",
          stageId: "extra-repair",
        },
      ],
    },
  };
}
