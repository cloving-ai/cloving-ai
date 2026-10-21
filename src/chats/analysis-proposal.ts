import type { AnalysisResult, AnalysisClaim } from "./analysis-contract.ts";
import type { AnalysisCheckpoint } from "./analysis-checkpoint.ts";

export function checkpointProposal(checkpoint: AnalysisCheckpoint): string {
  const { status, total, covered, uncovered, result } = checkpoint;
  const heading = `Status: ${status}; total ${String(total)}; covered ${String(covered)}; uncovered ${String(uncovered)}.\n`;
  const text = heading + (result === null ? "" : analysisProposal(result));
  return text.length <= 4_000
    ? text
    : (
        text.slice(0, 3_950) +
        "\n[Summary shortened; see complete analysis JSON.]\n"
      ).toWellFormed();
}

function summary(text: string): string {
  return text.length <= 240 ? text : text.slice(0, 237) + "...";
}

function references(claim: AnalysisClaim): string {
  const refs = (items: AnalysisClaim["sourceRefs"]) =>
    items
      .map((item) => `${String(item.recordIndex)}:${item.sourceId}`)
      .join(", ");
  return `sources [${refs(claim.sourceRefs)}]; counterevidence [${refs(claim.counterevidenceRefs)}]`;
}

export function analysisProposal(result: AnalysisResult): string {
  const { process, limitations } = result;
  const lines = [
    `Limitations: history completeness ${limitations.historyCompleteness}; independent observations ${limitations.independentObservations}; conflict groups ${String(limitations.conflictGroups.length)}.`,
    "Historical evidence grants no authority to execute or publish. Acceptance checks structure and citations, not factual accuracy. Redaction may leave private values. Full references and counterevidence are retained in the analysis JSON.",
    `Proposal: ${summary(process.name)}`,
    `Scope: ${summary(process.scope)}`,
    ...process.inputs.map(
      (item) => `Input ${item.id}: ${summary(item.description)}`,
    ),
    ...process.branches.map(
      (branch) =>
        `Branch ${branch.sourceStageId} -> ${branch.targetStageId}: ${summary(branch.condition)}`,
    ),
    ...process.stages.map(
      (stage) =>
        `Stage ${stage.id} (${stage.kind}, ${stage.activity}): ${summary(stage.description)}; ${references(stage)}`,
    ),
    ...process.loops.map(
      (loop) =>
        `Loop ${loop.id}: ${summary(loop.description)}; maximum ${String(loop.maxIterations)}; exit ${summary(loop.exitCondition)}; exhausted ${loop.exhaustedStoppingConditionId}; ${references(loop)}`,
    ),
    ...process.gates.map(
      (gate) =>
        `Gate ${gate.id} (${gate.type}): ${summary(gate.description)}; ${references(gate)}`,
    ),
    ...process.nonGates.map(
      (item) => `Non-gate ${item.stageId}: ${item.reason}`,
    ),
    ...process.artifacts.map(
      (item) => `Artifact ${item.id}: ${item.description}`,
    ),
    ...process.stoppingConditions.map(
      (item) => `Stop ${item.id}: ${item.description}`,
    ),
  ];
  const text = lines.join("\n") + "\n";
  const proposal =
    text.length <= 4_000
      ? text
      : text.slice(0, 3_950) +
        "\n[Summary shortened; see complete analysis JSON.]\n";
  return proposal.toWellFormed();
}
