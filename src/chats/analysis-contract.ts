import type { MessageRecord } from "./normalize.ts";
import type { ImportStructure, OccurrenceReference } from "./structure.ts";

export const analysisCodes = [
  "not-plain-data",
  "unknown-version",
  "invalid-shape",
  "unknown-kind",
  "unknown-decision-type",
  "missing-source",
  "unknown-source",
  "copy-only",
  "insufficient-repetition",
  "invalid-loop-limit",
  "gate-on-non-gate",
  "authority-field",
] as const;
export type AnalysisCode = (typeof analysisCodes)[number];
export type ClaimKind =
  | "explicit-human-instruction"
  | "observed-repetition"
  | "assistant-claim"
  | "exception"
  | "rejected-approach"
  | "uncertain-inference";
export type StageActivity =
  | "work"
  | "routine-repair"
  | "accidental-interruption"
  | "tool-imposed-confirmation";
export type DecisionType =
  "design-decision" | "configured-action-approval" | "factual-input";
export interface AnalysisItem {
  readonly id: string;
  readonly description: string;
}
export interface AnalysisClaim extends AnalysisItem {
  readonly kind: ClaimKind;
  readonly sourceRefs: readonly OccurrenceReference[];
  readonly counterevidenceRefs: readonly OccurrenceReference[];
}
export interface AnalysisStage extends AnalysisClaim {
  readonly activity: StageActivity;
}
export interface AnalysisGate extends AnalysisClaim {
  readonly stageId: string;
  readonly type: DecisionType;
}
export interface AnalysisLoop extends AnalysisClaim {
  readonly stageIds: readonly string[];
  readonly maxIterations: number;
  readonly exitCondition: string;
  readonly exhaustedStoppingConditionId: string;
}
export interface AnalysisBranch extends AnalysisItem {
  readonly sourceStageId: string;
  readonly condition: string;
  readonly targetStageId: string;
}
export interface AnalysisNonGate extends AnalysisItem {
  readonly stageId: string;
  readonly reason: Exclude<StageActivity, "work">;
}
export interface AnalysisProcess {
  readonly id: string;
  readonly name: string;
  readonly scope: string;
  readonly inputs: readonly AnalysisItem[];
  readonly stages: readonly AnalysisStage[];
  readonly branches: readonly AnalysisBranch[];
  readonly loops: readonly AnalysisLoop[];
  readonly artifacts: readonly AnalysisItem[];
  readonly stoppingConditions: readonly AnalysisItem[];
  readonly gates: readonly AnalysisGate[];
  readonly nonGates: readonly AnalysisNonGate[];
}
export interface AnalysisCandidate {
  readonly schemaVersion: 1;
  readonly process: AnalysisProcess;
}
export interface AnalysisEvidence {
  readonly records: readonly MessageRecord[];
  readonly structure: ImportStructure;
}
export interface AnalysisResult extends AnalysisCandidate {
  readonly limitations: {
    readonly historyCompleteness: "unknown";
    readonly independentObservations: "not-established";
    readonly conflictGroups: ImportStructure["conflictGroups"];
  };
}
export type AnalysisValidation =
  | { readonly accepted: true; readonly result: AnalysisResult }
  | { readonly accepted: false; readonly codes: readonly AnalysisCode[] };
