import type {
  AnalysisClaim,
  AnalysisCode,
  AnalysisEvidence,
  AnalysisProcess,
} from "./analysis-contract.ts";
import type { MessageRecord } from "./normalize.ts";
import type { Occurrence, OccurrenceReference } from "./structure.ts";

function identityMatches(
  record: MessageRecord,
  occurrence: Occurrence,
): boolean {
  if (
    record.sourceId !== occurrence.sourceId ||
    record.sessionId !== occurrence.sessionId
  )
    return false;
  if (record.schemaVersion === 1)
    return (
      occurrence.uuid === null &&
      occurrence.isSidechain === null &&
      !Object.hasOwn(occurrence, "parentUuid")
    );
  return (
    record.uuid === occurrence.uuid &&
    record.isSidechain === occurrence.isSidechain &&
    Object.hasOwn(record, "parentUuid") ===
      Object.hasOwn(occurrence, "parentUuid") &&
    record.parentUuid === occurrence.parentUuid
  );
}

function validCopy(
  occurrence: Occurrence,
  occurrences: readonly Occurrence[],
): boolean {
  const reference = occurrence.copyOf;
  if (reference === undefined) return true;
  if (
    !Number.isSafeInteger(reference.recordIndex) ||
    reference.recordIndex < 0 ||
    reference.recordIndex >= occurrence.recordIndex
  )
    return false;
  const original = occurrences[reference.recordIndex];
  return (
    original !== undefined &&
    original.sourceId === reference.sourceId &&
    original.copyOf === undefined &&
    typeof occurrence.uuid === "string" &&
    occurrence.uuid !== "" &&
    original.uuid === occurrence.uuid
  );
}

export function matchingAnalysisEvidence(evidence: AnalysisEvidence): boolean {
  const { records, structure } = evidence;
  if (
    !unknownHistory(structure.historyCompleteness) ||
    structure.occurrences.length !== records.length ||
    structure.counts.records !== records.length
  )
    return false;
  return records.every((record, index) => {
    const occurrence = structure.occurrences[index];
    return (
      occurrence !== undefined &&
      occurrence.recordIndex === index &&
      identityMatches(record, occurrence) &&
      validCopy(occurrence, structure.occurrences)
    );
  });
}

function unknownHistory(value: unknown): boolean {
  return value === "unknown";
}

function sourceList(value: unknown): value is readonly OccurrenceReference[] {
  return Array.isArray(value);
}

function knownReference(
  reference: OccurrenceReference,
  evidence: AnalysisEvidence,
): boolean {
  return (
    evidence.records[reference.recordIndex]?.sourceId === reference.sourceId &&
    evidence.structure.occurrences[reference.recordIndex]?.sourceId ===
      reference.sourceId
  );
}

function inspectSupport(
  claim: AnalysisClaim,
  evidence: AnalysisEvidence,
): readonly AnalysisCode[] {
  const codes: AnalysisCode[] = [];
  const sources = claim.sourceRefs;
  if (
    claim.counterevidenceRefs.some(
      (reference) => !knownReference(reference, evidence),
    )
  )
    codes.push("unknown-source");
  if (!sourceList(sources) || sources.length === 0) return codes;
  if (sources.some((reference) => !knownReference(reference, evidence)))
    return [...codes, "unknown-source"];
  const originals = new Set(
    sources
      .filter(
        (reference) =>
          evidence.structure.occurrences[reference.recordIndex]?.copyOf ===
          undefined,
      )
      .map((reference) => reference.sourceId),
  );
  if (originals.size === 0) return [...codes, "copy-only"];
  if (claim.kind === "observed-repetition" && originals.size < 2)
    codes.push("insufficient-repetition");
  return codes;
}

export function inspectAnalysisSupport(
  process: AnalysisProcess,
  evidence: AnalysisEvidence,
): readonly AnalysisCode[] {
  return [...process.stages, ...process.gates, ...process.loops].flatMap(
    (claim) => inspectSupport(claim, evidence),
  );
}
