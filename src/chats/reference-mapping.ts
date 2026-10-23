import { parseCorpus } from "./corpus-input.ts";
import { parseEvidenceCoverage } from "./revision-input.ts";
import {
  compareEvidence,
  pairEvidence,
  type EvidenceSource,
  type RevisionEntry,
} from "./revision.ts";
import type { OccurrenceReference } from "./structure.ts";

export interface EvidenceMappingSnapshot {
  readonly importId: string;
  readonly coverage: string;
  readonly corpus: string;
}

export interface EvidenceReferenceMapping {
  readonly previous: OccurrenceReference;
  readonly current: OccurrenceReference;
}

interface MappingOccurrence {
  readonly reference: OccurrenceReference;
  readonly offset: number;
}

interface MappingSelection extends EvidenceSource {
  readonly occurrences: readonly MappingOccurrence[];
}

function coverageEntries(coverage: object): unknown {
  if ("files" in coverage) return coverage.files;
  if ("entries" in coverage) return coverage.entries;
  throw new Error("analysis-reference-map-refused");
}

function coverageCounts(text: string): readonly number[] {
  const coverage: unknown = JSON.parse(text);
  if (coverage === null || typeof coverage !== "object")
    throw new Error("analysis-reference-map-refused");
  const entries = coverageEntries(coverage);
  if (!Array.isArray(entries))
    throw new Error("analysis-reference-map-refused");
  return entries.map((entry: unknown) => {
    if (
      entry === null ||
      typeof entry !== "object" ||
      !("recordCount" in entry) ||
      typeof entry.recordCount !== "number" ||
      !Number.isSafeInteger(entry.recordCount) ||
      entry.recordCount < 0
    )
      throw new Error("analysis-reference-map-refused");
    return entry.recordCount;
  });
}

function occurrence(
  source: EvidenceSource,
  reference: OccurrenceReference,
): MappingOccurrence {
  const match = /^(sha256:[a-f\d]{64}):(0|[1-9]\d*)$/.exec(reference.sourceId);
  if (match === null || match[1] !== source.digest)
    throw new Error("analysis-reference-map-refused");
  const offset = Number(match[2]);
  if (
    !Number.isSafeInteger(offset) ||
    (source.byteSize !== undefined && offset >= source.byteSize)
  )
    throw new Error("analysis-reference-map-refused");
  return { reference, offset };
}

function readSelections(
  snapshot: EvidenceMappingSnapshot,
): readonly MappingSelection[] {
  if (
    !/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/.test(
      snapshot.importId,
    )
  )
    throw new Error("analysis-reference-map-refused");
  const sources = parseEvidenceCoverage(snapshot.coverage, snapshot.importId);
  const records = parseCorpus(snapshot.corpus);
  const counts = coverageCounts(snapshot.coverage);
  if (
    counts.reduce((total, count) => total + count, 0) !== records.length ||
    sources.some(
      (source, index) => source.status !== "included" && counts[index] !== 0,
    )
  )
    throw new Error("analysis-reference-map-refused");
  let index = 0;
  return sources.map((source, selectionIndex) => {
    const count = counts[selectionIndex];
    if (count === undefined) throw new Error("analysis-reference-map-refused");
    const occurrences = records
      .slice(index, index + count)
      .map((record, offset) =>
        occurrence(source, {
          recordIndex: index + offset,
          sourceId: record.sourceId,
        }),
      );
    if (
      occurrences.some(
        (item, offset) =>
          offset > 0 && item.offset <= (occurrences[offset - 1]?.offset ?? -1),
      )
    )
      throw new Error("analysis-reference-map-refused");
    index += count;
    return { ...source, occurrences };
  });
}

function revisionIdentity(entry: RevisionEntry): string {
  return JSON.stringify([
    entry.path,
    entry.root,
    entry.status,
    entry.reason,
    entry.before === null ? null : [entry.before.digest, entry.before.byteSize],
    entry.after === null ? null : [entry.after.digest, entry.after.byteSize],
  ]);
}

function verifyRevision(data: {
  readonly previous: readonly MappingSelection[];
  readonly current: readonly MappingSelection[];
  readonly revision: readonly RevisionEntry[];
}): void {
  const expected = compareEvidence({
    previous: data.previous,
    current: data.current.map((source, index) => {
      const revision = data.revision[index];
      return {
        ...source,
        prefixDigest:
          revision?.status === "extended"
            ? (revision.before?.digest ?? undefined)
            : undefined,
      };
    }),
  }).entries;
  if (
    data.revision.length !== expected.length ||
    expected.some((entry, index) => {
      const actual = data.revision[index];
      return (
        actual === undefined ||
        revisionIdentity(entry) !== revisionIdentity(actual)
      );
    })
  )
    throw new Error("analysis-reference-map-refused");
}

function verifyUnchangedSelection(
  before: MappingSelection,
  after: MappingSelection,
): void {
  if (
    before.byteSize !== undefined &&
    after.byteSize !== undefined &&
    before.byteSize !== after.byteSize
  )
    throw new Error("analysis-reference-map-refused");
  if (before.occurrences.length !== after.occurrences.length)
    throw new Error("analysis-reference-map-refused");
}

function verifyExtendedSelection(
  before: MappingSelection,
  after: MappingSelection,
): void {
  const prefix = after.occurrences.filter(
    (item) => item.offset < (before.byteSize ?? 0),
  );
  if (
    prefix.length !== before.occurrences.length ||
    prefix.some(
      (item, index) => item.offset !== before.occurrences[index]?.offset,
    )
  )
    throw new Error("analysis-reference-map-refused");
}

function mapSelection(data: {
  readonly before: MappingSelection;
  readonly after: MappingSelection;
  readonly revision: RevisionEntry | undefined;
}): readonly EvidenceReferenceMapping[] {
  const { before, after, revision } = data;
  if (revision?.status !== "unchanged" && revision?.status !== "extended")
    return [];
  if (revision.status === "unchanged") verifyUnchangedSelection(before, after);
  if (revision.status === "extended") verifyExtendedSelection(before, after);
  const indexes = new Map(
    after.occurrences.map((item, index) => [item.offset, index]),
  );
  return before.occurrences.flatMap((item) => {
    const index = indexes.get(item.offset);
    const matched = index === undefined ? undefined : after.occurrences[index];
    if (matched === undefined || index === undefined)
      throw new Error("analysis-reference-map-refused");
    const next = after.occurrences[index + 1];
    if (
      revision.status === "extended" &&
      (before.byteSize === undefined ||
        next === undefined ||
        next.offset > before.byteSize)
    )
      return [];
    return [{ previous: item.reference, current: matched.reference }];
  });
}

export function mapEvidenceReferences(data: {
  readonly previous: EvidenceMappingSnapshot;
  readonly current: EvidenceMappingSnapshot;
  readonly revision: readonly RevisionEntry[];
}): readonly EvidenceReferenceMapping[] {
  try {
    const previous = readSelections(data.previous);
    const current = readSelections(data.current);
    verifyRevision({ previous, current, revision: data.revision });
    const pairs = pairEvidence({ previous, current });
    const mappings = current.flatMap((after, index) => {
      const beforeIndex = pairs[index];
      const before =
        beforeIndex === null || beforeIndex === undefined
          ? undefined
          : previous[beforeIndex];
      return before === undefined
        ? []
        : mapSelection({ before, after, revision: data.revision[index] });
    });
    return mappings.sort(
      (left, right) => left.previous.recordIndex - right.previous.recordIndex,
    );
  } catch {
    throw new Error("analysis-reference-map-refused");
  }
}
