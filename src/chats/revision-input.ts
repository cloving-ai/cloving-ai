import { validateCoverage, withinRoot } from "./corpus-input.ts";
import {
  evidenceReason,
  revisionReasons,
  type EvidenceSource,
  type EvidenceValue,
  type ComparableEvidence,
} from "./revision.ts";

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exact(
  value: Record<string, unknown>,
  fields: {
    readonly required: readonly string[];
    readonly optional?: readonly string[];
  },
): boolean {
  const { required, optional = [] } = fields;
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every(
      (key) => required.includes(key) || optional.includes(key),
    )
  );
}

function natural(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function absolute(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith("/") &&
    !value.includes("\0") &&
    value.split("/").every((part) => part !== "." && part !== "..")
  );
}

function digest(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" && /^sha256:[a-f\d]{64}$/.test(value))
  );
}

function evidenceValue(value: unknown): value is Record<string, unknown> & {
  digest: string | null;
  byteSize?: number;
} {
  return (
    object(value) &&
    digest(value["digest"]) &&
    (!Object.hasOwn(value, "byteSize") ||
      (natural(value["byteSize"]) && value["byteSize"] <= 10_485_760))
  );
}

function source(value: unknown, roots: readonly string[]): EvidenceSource {
  if (
    !evidenceValue(value) ||
    !absolute(value["path"]) ||
    typeof value["status"] !== "string"
  )
    throw new Error("invalid-import");
  return {
    path: value["path"],
    root: selectedRoot(value["selection"], roots),
    status: value["status"],
    digest: value.digest,
    ...(value.byteSize === undefined ? {} : { byteSize: value.byteSize }),
  };
}

export function parseEvidenceCoverage(
  text: string,
  importId: string,
): readonly EvidenceSource[] {
  validateCoverage(text, importId);
  const value: unknown = JSON.parse(text);
  if (!object(value)) throw new Error("invalid-import");
  const entries =
    value["schemaVersion"] === 1 ? value["files"] : value["entries"];
  const roots = value["schemaVersion"] === 1 ? [] : value["roots"];
  if (
    !Array.isArray(entries) ||
    !Array.isArray(roots) ||
    !roots.every((root: unknown): root is string => typeof root === "string")
  )
    throw new Error("invalid-import");
  return entries.map((entry: unknown) => source(entry, roots));
}

function revisionValue(value: unknown): value is EvidenceValue | null {
  return (
    value === null ||
    (evidenceValue(value) &&
      exact(value, { required: ["digest"], optional: ["byteSize"] }))
  );
}

function revisionEntry(value: unknown): value is Record<string, unknown> {
  if (
    !object(value) ||
    !exact(value, {
      required: ["path", "root", "before", "after", "status", "reason"],
    })
  )
    return false;
  if (!selectionKey(value)) return false;
  const reason = value["reason"];
  if (typeof reason !== "string" || !Object.hasOwn(revisionReasons, reason))
    return false;
  const expected = Object.entries(revisionReasons).find(
    ([key]) => key === reason,
  )?.[1];
  return (
    value["status"] === expected &&
    revisionPresence(value) &&
    consistentReason(value)
  );
}

function revisionPresence(value: Record<string, unknown>): boolean {
  const reason = value["reason"];
  if (reason === "no-previous-entry")
    return value["before"] === null && value["after"] !== null;
  if (reason === "not-selected")
    return value["before"] !== null && value["after"] === null;
  return value["before"] !== null && value["after"] !== null;
}

function validCounts(
  value: unknown,
  entries: readonly Record<string, unknown>[],
): boolean {
  const statuses = [
    "new",
    "missing",
    "unchanged",
    "changed",
    "truncated",
    "extended",
  ];
  return (
    object(value) &&
    exact(value, { required: statuses }) &&
    statuses.every(
      (status) =>
        natural(value[status]) &&
        value[status] ===
          entries.filter((entry) => entry["status"] === status).length,
    )
  );
}

export function nextEvidenceRevision(
  text: string | undefined,
  importId: string,
): number {
  if (text === undefined) return 1;
  const value: unknown = JSON.parse(text);
  if (
    !object(value) ||
    !exact(value, {
      required: [
        "schemaVersion",
        "importId",
        "previousImportId",
        "evidenceRevision",
        "counts",
        "entries",
      ],
    })
  )
    throw new Error("invalid-import");
  if (!revisionHeader(value, importId)) throw new Error("invalid-import");
  const entries = value["entries"];
  if (
    !Array.isArray(entries) ||
    !entries.every(revisionEntry) ||
    !validCounts(value["counts"], entries)
  )
    throw new Error("invalid-import");
  const revision = value["evidenceRevision"];
  if (!natural(revision)) throw new Error("invalid-import");
  return revision + 1;
}

function selectedRoot(
  selection: unknown,
  roots: readonly string[],
): string | null {
  if (roots.length === 0 || !object(selection) || selection["kind"] !== "root")
    return null;
  const index = selection["index"];
  if (!natural(index) || roots[index] === undefined)
    throw new Error("invalid-import");
  return roots[index];
}

function selectionKey(value: Record<string, unknown>): boolean {
  return (
    absolute(value["path"]) &&
    (value["root"] === null ||
      (absolute(value["root"]) && withinRoot(value["root"], value["path"])))
  );
}

function revisionHeader(
  value: Record<string, unknown>,
  importId: string,
): boolean {
  const revision = value["evidenceRevision"];
  if (
    value["schemaVersion"] !== 1 ||
    value["importId"] !== importId ||
    !natural(revision) ||
    revision === 0 ||
    revision === Number.MAX_SAFE_INTEGER
  )
    return false;
  const previous = value["previousImportId"];
  if (
    typeof previous !== "string" ||
    previous === importId ||
    !/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/.test(
      previous,
    )
  )
    return false;
  return true;
}

function consistentReason(value: Record<string, unknown>): boolean {
  const before = value["before"];
  const after = value["after"];
  if (!revisionValue(before) || !revisionValue(after)) return false;
  const reason = value["reason"];
  const unverified = [
    "no-previous-entry",
    "not-selected",
    "not-included",
  ].includes(String(reason));
  if (!unverified && after?.digest === null) return false;
  const prefix = reason === "verified-prefix" ? before?.digest : undefined;
  return (
    evidenceReason({
      before: comparable(before, { status: "included" }),
      after: comparable(after, {
        status: reason === "not-included" ? "unsupported" : "included",
        prefixDigest: prefix ?? undefined,
      }),
    }) === reason
  );
}

function comparable(
  value: EvidenceValue | null,
  state: {
    readonly status: string;
    readonly prefixDigest?: string | undefined;
  },
): ComparableEvidence | null {
  return value === null ? null : { ...value, ...state };
}
