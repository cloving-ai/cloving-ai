import type {
  AnalysisCode,
  AnalysisProcess,
  AnalysisStage,
} from "./analysis-contract.ts";

function validNonGate(stage: AnalysisStage, process: AnalysisProcess): boolean {
  const classifications = process.nonGates.filter(
    (item) => item.stageId === stage.id,
  );
  if (stage.activity === "work") return classifications.length === 0;
  return (
    classifications.length === 1 &&
    classifications[0]?.reason === stage.activity &&
    !process.gates.some((gate) => gate.stageId === stage.id)
  );
}

export function inspectAnalysisLinks(
  process: AnalysisProcess,
): readonly AnalysisCode[] {
  const codes = new Set<AnalysisCode>();
  const stages = new Set(process.stages.map((stage) => stage.id));
  const stopping = new Set(process.stoppingConditions.map((item) => item.id));
  if (
    process.branches.some(
      (branch) =>
        !stages.has(branch.sourceStageId) || !stages.has(branch.targetStageId),
    )
  )
    codes.add("invalid-shape");
  if (
    process.loops.some(
      (loop) =>
        loop.stageIds.some((id) => !stages.has(id)) ||
        !stopping.has(loop.exhaustedStoppingConditionId),
    )
  )
    codes.add("invalid-shape");
  if (
    [...process.gates, ...process.nonGates].some(
      (item) => !stages.has(item.stageId),
    )
  )
    codes.add("invalid-shape");
  if (codes.has("invalid-shape")) return [...codes];
  if (process.stages.some((stage) => !validNonGate(stage, process)))
    codes.add("gate-on-non-gate");
  return [...codes];
}
