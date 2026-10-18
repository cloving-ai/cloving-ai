export interface SelectionKey {
  readonly path: string;
  readonly root: string | null;
}

export interface EvidenceValue {
  readonly digest: string | null;
  readonly byteSize?: number | undefined;
}

export interface ComparableEvidence extends EvidenceValue {
  readonly status: string;
  readonly prefixDigest?: string | undefined;
}

export interface EvidenceSource extends SelectionKey, ComparableEvidence {}

export const revisionReasons = {
  "no-previous-entry": "new",
  "not-selected": "missing",
  "not-included": "missing",
  "same-digest": "unchanged",
  "previous-digest-unknown": "changed",
  "previous-size-unknown": "changed",
  "shorter-source": "truncated",
  "verified-prefix": "extended",
  "digest-changed": "changed",
} as const;

export type RevisionReason = keyof typeof revisionReasons;
export type RevisionStatus = (typeof revisionReasons)[RevisionReason];
export interface RevisionEntry extends SelectionKey {
  readonly before: EvidenceValue | null;
  readonly after: EvidenceValue | null;
  readonly status: RevisionStatus;
  readonly reason: RevisionReason;
}

export function pairEvidence(data: {
  readonly previous: readonly SelectionKey[];
  readonly current: readonly SelectionKey[];
}): readonly (number | null)[] {
  const queues = new Map<string, number[]>();
  const key = (entry: SelectionKey) => JSON.stringify([entry.path, entry.root]);
  data.previous.forEach((entry, index) => {
    const encoded = key(entry);
    const queue = queues.get(encoded) ?? [];
    queue.push(index);
    queues.set(encoded, queue);
  });
  return data.current.map((entry) => queues.get(key(entry))?.shift() ?? null);
}

export function evidenceReason(data: {
  readonly before: ComparableEvidence | null;
  readonly after: ComparableEvidence | null;
}): RevisionReason {
  const { before, after } = data;
  if (before === null) return "no-previous-entry";
  if (after === null) return "not-selected";
  if (after.status !== "included") return "not-included";
  if (before.digest !== null && before.digest === after.digest)
    return "same-digest";
  if (before.digest === null) return "previous-digest-unknown";
  if (before.byteSize === undefined) return "previous-size-unknown";
  return sizeReason({ ...before, byteSize: before.byteSize }, after);
}

function sizeReason(
  before: ComparableEvidence & { byteSize: number },
  after: ComparableEvidence,
): RevisionReason {
  if (after.byteSize !== undefined && after.byteSize < before.byteSize)
    return "shorter-source";
  if (
    after.byteSize !== undefined &&
    after.byteSize > before.byteSize &&
    after.prefixDigest === before.digest
  )
    return "verified-prefix";
  return "digest-changed";
}

function value(source: EvidenceSource | undefined): EvidenceValue | null {
  if (source === undefined) return null;
  return {
    digest: source.digest,
    ...(source.byteSize === undefined ? {} : { byteSize: source.byteSize }),
  };
}

function entry(
  before: EvidenceSource | undefined,
  after: EvidenceSource | undefined,
): RevisionEntry {
  const key = after ?? before;
  if (key === undefined) throw new Error("invalid-evidence");
  const why = evidenceReason({ before: before ?? null, after: after ?? null });
  return {
    path: key.path,
    root: key.root,
    before: value(before),
    after: value(after),
    status: revisionReasons[why],
    reason: why,
  };
}

export function compareEvidence(data: {
  readonly previous: readonly EvidenceSource[];
  readonly current: readonly EvidenceSource[];
}) {
  const pairs = pairEvidence(data);
  const used = new Set(pairs);
  const entries = data.current.map((after, index) => {
    const matched = pairs[index];
    return entry(
      matched === null || matched === undefined
        ? undefined
        : data.previous[matched],
      after,
    );
  });
  data.previous.forEach((before, index) => {
    if (!used.has(index)) entries.push(entry(before, undefined));
  });
  const counts: Record<RevisionStatus, number> = {
    new: 0,
    missing: 0,
    unchanged: 0,
    changed: 0,
    truncated: 0,
    extended: 0,
  };
  for (const item of entries) counts[item.status]++;
  return { counts, entries };
}
