import type {
  AnalysisCandidate,
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
  const historyCompleteness: unknown = structure.historyCompleteness;
  if (
    historyCompleteness !== "unknown" ||
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
  if (!Array.isArray(claim.sourceRefs) || sources.length === 0) return codes;
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

function referenceKey(reference: OccurrenceReference): string {
  return JSON.stringify([reference.recordIndex, reference.sourceId]);
}

export function inspectAnalysisQuestion(
  candidate: AnalysisCandidate,
  evidence: AnalysisEvidence,
): readonly AnalysisCode[] {
  const question = candidate.openQuestion;
  if (question === undefined) return [];
  const references = question.sourceRefs.map(referenceKey);
  if (new Set(references).size !== references.length)
    return ["invalid-question"];
  if (
    question.sourceRefs.some(
      (reference) => !knownReference(reference, evidence),
    )
  )
    return ["unknown-source"];
  const process = candidate.process;
  const claim = [...process.stages, ...process.gates, ...process.loops].find(
    (claim) => claim.id === question.claimId,
  );
  if (claim === undefined) return ["question-without-conflict"];
  if (!Array.isArray(claim.sourceRefs)) return ["question-without-conflict"];
  const support = new Set(claim.sourceRefs.map(referenceKey));
  const counterevidence = new Set(claim.counterevidenceRefs.map(referenceKey));
  const supports = references.filter((reference) => support.has(reference));
  const counters = references.filter((reference) =>
    counterevidence.has(reference),
  );
  if (
    references.some(
      (reference) => !support.has(reference) && !counterevidence.has(reference),
    ) ||
    !supports.some((support) => counters.some((counter) => counter !== support))
  )
    return ["question-without-conflict"];
  return [];
}
