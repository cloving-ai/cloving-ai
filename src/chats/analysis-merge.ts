import {
  validateAnalysis,
  type AnalysisClaim,
  type AnalysisCode,
  type AnalysisEvidence,
  type AnalysisItem,
  type AnalysisProcess,
  type AnalysisResult,
} from "./analysis.ts";
import type { OccurrenceReference } from "./structure.ts";
import { inspectAnalysisData } from "./analysis-data.ts";
import { inspectAnalysisBatchShape } from "./analysis-shape.ts";
import { analysisCodes } from "./analysis-contract.ts";
import { matchingAnalysisEvidence } from "./analysis-provenance.ts";

const collections = [
  "inputs",
  "stages",
  "branches",
  "loops",
  "artifacts",
  "stoppingConditions",
  "gates",
  "nonGates",
] as const;

export interface AnalysisMergeInput {
  readonly previousResult: AnalysisResult | null;
  readonly candidate: unknown;
  readonly evidence: AnalysisEvidence;
  readonly nextRecordIndex: number;
}

export type AnalysisMergeCode =
  AnalysisCode | "analysis-merge-conflict" | "analysis-input-refused";

export type AnalysisMergeValidation =
  | { readonly accepted: true; readonly result: AnalysisResult }
  | {
      readonly accepted: false;
      readonly codes: readonly AnalysisMergeCode[];
    };

function referencesInOrder(
  left: readonly OccurrenceReference[],
  right: readonly OccurrenceReference[],
): readonly OccurrenceReference[] {
  const references = new Map(
    [...left, ...right].map((reference) => [
      JSON.stringify([reference.recordIndex, reference.sourceId]),
      reference,
    ]),
  );
  return [...references.values()].sort(
    (left, right) => left.recordIndex - right.recordIndex,
  );
}

function isClaim(item: AnalysisItem): item is AnalysisClaim {
  return "sourceRefs" in item && "counterevidenceRefs" in item;
}

function mergeCollection<T extends AnalysisItem>(
  previous: readonly T[],
  incoming: readonly T[],
): readonly T[] {
  const merged = new Map(previous.map((item) => [item.id, item]));
  for (const item of incoming) {
    const earlier = merged.get(item.id);
    if (!isClaim(item)) {
      merged.set(item.id, item);
      continue;
    }
    const prior =
      earlier !== undefined && isClaim(earlier) ? earlier : undefined;
    merged.set(item.id, {
      ...item,
      sourceRefs: referencesInOrder(prior?.sourceRefs ?? [], item.sourceRefs),
      counterevidenceRefs: referencesInOrder(
        prior?.counterevidenceRefs ?? [],
        item.counterevidenceRefs,
      ),
    });
  }
  return [...merged.values()];
}

function mergeProcess(
  previous: AnalysisProcess | undefined,
  incoming: AnalysisProcess,
): AnalysisProcess {
  const earlier = previous ?? incoming;
  return {
    ...incoming,
    inputs: mergeCollection(earlier.inputs, incoming.inputs),
    stages: mergeCollection(earlier.stages, incoming.stages),
    branches: mergeCollection(earlier.branches, incoming.branches),
    loops: mergeCollection(earlier.loops, incoming.loops),
    artifacts: mergeCollection(earlier.artifacts, incoming.artifacts),
    stoppingConditions: mergeCollection(
      earlier.stoppingConditions,
      incoming.stoppingConditions,
    ),
    gates: mergeCollection(earlier.gates, incoming.gates),
    nonGates: mergeCollection(earlier.nonGates, incoming.nonGates),
  };
}

function nonReferences(item: AnalysisItem): string {
  return JSON.stringify(
    Object.entries(item)
      .filter(([key]) => !["sourceRefs", "counterevidenceRefs"].includes(key))
      .sort(([left], [right]) => (left < right ? -1 : Number(left > right))),
  );
}

function mergeConflict(
  previous: AnalysisProcess | undefined,
  incoming: AnalysisProcess,
): boolean {
  if (previous === undefined) return false;
  if (
    ["id", "name", "scope"].some(
      (key) => Reflect.get(previous, key) !== Reflect.get(incoming, key),
    )
  )
    return true;
  const earlier = new Map(
    collections.flatMap((collection) =>
      previous[collection].map(
        (item) => [item.id, { collection, item }] as const,
      ),
    ),
  );
  return collections.some((collection) =>
    incoming[collection].some((item) => {
      const prior = earlier.get(item.id);
      return (
        prior !== undefined &&
        (prior.collection !== collection ||
          nonReferences(prior.item) !== nonReferences(item))
      );
    }),
  );
}

function processedEvidence(input: AnalysisMergeInput): AnalysisEvidence {
  const { records, structure } = input.evidence;
  const end = input.nextRecordIndex;
  return {
    records: records.slice(0, end),
    structure: {
      ...structure,
      counts: { ...structure.counts, records: end },
      occurrences: structure.occurrences.slice(0, end),
      conflictGroups: structure.conflictGroups
        .map((group) => ({
          ...group,
          variants: group.variants
            .map((variant) =>
              variant.filter((reference) => reference.recordIndex < end),
            )
            .filter((variant) => variant.length > 0),
        }))
        .filter((group) => group.variants.length > 0),
    },
  };
}

function priorCodes(
  previous: AnalysisResult | null,
  evidence: AnalysisEvidence,
): readonly AnalysisMergeCode[] {
  if (previous === null) return [];
  const codes = inspectAnalysisData(previous);
  if (codes.length > 0) return codes;
  if (previous.openQuestion !== undefined) return ["analysis-input-refused"];
  const candidate = Object.fromEntries(
    Object.entries(previous).filter(([key]) => key !== "limitations"),
  );
  const validation = validateAnalysis(candidate, evidence);
  return validation.accepted ? [] : validation.codes;
}

function validInput(input: AnalysisMergeInput): boolean {
  return (
    Number.isSafeInteger(input.nextRecordIndex) &&
    input.nextRecordIndex > 0 &&
    input.nextRecordIndex <= input.evidence.records.length &&
    matchingAnalysisEvidence(input.evidence)
  );
}

export function mergeAnalysisBatch(
  input: AnalysisMergeInput,
): AnalysisMergeValidation {
  if (!validInput(input))
    return { accepted: false, codes: ["analysis-input-refused"] };
  const evidence = processedEvidence(input);
  const previousCodes = priorCodes(input.previousResult, evidence);
  if (previousCodes.length > 0)
    return { accepted: false, codes: previousCodes };
  const codes = new Set(inspectAnalysisData(input.candidate));
  if (codes.has("not-plain-data"))
    return { accepted: false, codes: ["not-plain-data"] };
  if (!inspectAnalysisBatchShape(input.candidate, codes) || codes.size > 0)
    return {
      accepted: false,
      codes: analysisCodes.filter((code) => codes.has(code)),
    };
  if (mergeConflict(input.previousResult?.process, input.candidate.process))
    return { accepted: false, codes: ["analysis-merge-conflict"] };
  return validateAnalysis(
    {
      ...input.candidate,
      process: mergeProcess(
        input.previousResult?.process,
        input.candidate.process,
      ),
    },
    evidence,
  );
}
