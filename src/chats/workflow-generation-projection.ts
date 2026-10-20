import type {
  AnalysisProcess,
  AnalysisResult,
  AnalysisStage,
} from "./analysis-contract.ts";
import type { InstalledWorkflowExports } from "../workflow-candidate.ts";

export interface WorkflowGenerationAvailability {
  readonly exports: InstalledWorkflowExports;
  readonly methods: Readonly<Record<string, readonly string[]>>;
}

const generationExports = {
  "cloving/workflows": ["CycleOutcome", "ProtectedResult"],
  "cloving/workflows/steps/protected-effect": ["protectedEffect"],
  "cloving/workflows/steps/decision-gate": ["decisionGate"],
} as const;

export function executionStages(
  process: AnalysisProcess,
): readonly AnalysisStage[] {
  return process.stages.filter(
    (stage) =>
      ["explicit-human-instruction", "observed-repetition"].includes(
        stage.kind,
      ) && ["work", "routine-repair"].includes(stage.activity),
  );
}

function supportedBranch(process: AnalysisProcess): boolean {
  const [review, repair] = executionStages(process);
  const branch = process.branches[0];
  return (
    process.branches.length === 1 &&
    branch !== undefined &&
    branch.sourceStageId === review?.id &&
    branch.targetStageId === repair?.id &&
    branch.condition === "Defect found."
  );
}

function supportedLoop(process: AnalysisProcess): boolean {
  const loop = process.loops[0];
  if (process.loops.length !== 1 || loop === undefined) return false;
  return (
    JSON.stringify(loop.stageIds) ===
      JSON.stringify(executionStages(process).map((stage) => stage.id)) &&
    loop.exitCondition === "Checks and review pass." &&
    loop.kind === "explicit-human-instruction" &&
    process.stoppingConditions.some(
      (stop) => stop.id === loop.exhaustedStoppingConditionId,
    )
  );
}

function supportedGates(process: AnalysisProcess): boolean {
  const review = executionStages(process)[0];
  return (
    process.gates.every(
      (gate) =>
        gate.stageId === review?.id &&
        !["exception", "rejected-approach", "assistant-claim"].includes(
          gate.kind,
        ),
    ) &&
    process.gates.filter((gate) => gate.type !== "factual-input").length <= 1
  );
}

function controlGaps(process: AnalysisProcess): readonly string[] {
  const stages = executionStages(process);
  const [review, repair] = stages;
  const loop = process.loops[0];
  const limit = (loop?.maxIterations ?? 0) * 2;
  return [
    {
      code: "ambiguous-stages",
      supported:
        stages.length === 2 &&
        review?.activity === "work" &&
        repair?.activity === "routine-repair",
    },
    { code: "unsupported-branch", supported: supportedBranch(process) },
    { code: "unsupported-loops", supported: supportedLoop(process) },
    { code: "unsupported-gates", supported: supportedGates(process) },
    {
      code: "effect-limit",
      supported: Number.isSafeInteger(limit) && limit >= 1 && limit <= 100,
    },
  ]
    .filter((item) => !item.supported)
    .map((item) => item.code);
}

export function generationGaps(
  analysis: AnalysisResult,
  availability: WorkflowGenerationAvailability,
): readonly string[] {
  const gaps: string[] = [];
  if (analysis.openQuestion) gaps.push("unresolved-analysis-question");
  gaps.push(...controlGaps(analysis.process));
  for (const [module, names] of Object.entries(generationExports)) {
    const installed = Object.hasOwn(availability.exports, module)
      ? availability.exports[module]
      : undefined;
    for (const name of names)
      if (!installed?.includes(name))
        gaps.push(`missing-export:${module}#${name}`);
  }
  if (!Object.hasOwn(availability.methods, "claude"))
    gaps.push("missing-capability:claude");
  else if (!availability.methods["claude"]?.includes("run-turn"))
    gaps.push("missing-method:claude#run-turn");
  return gaps;
}
