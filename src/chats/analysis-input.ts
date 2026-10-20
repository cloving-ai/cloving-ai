import { record } from "../protocol.ts";
import { parseCorpus } from "./corpus-input.ts";
import type { AnalysisEvidence } from "./analysis-contract.ts";
import { structureImport, type ImportStructure } from "./structure.ts";
import { categories } from "./redaction.ts";

export const analysisDocumentBytes = 65_536;
export interface AnalysisSnapshot {
  readonly importId: string;
  readonly redaction: string;
  readonly corpus: string;
  readonly structure: string;
}

export function validAnalysisImportId(value: string): boolean {
  return /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/.test(
    value,
  );
}

function natural(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validCounts(value: unknown, total: unknown): boolean {
  const counts = record(value);
  if (counts === undefined || Object.keys(counts).length !== categories.length)
    return false;
  return (
    categories.every((category) => natural(counts[category])) &&
    natural(total) &&
    total ===
      Object.values(counts).reduce<number>(
        (sum, count) => sum + Number(count),
        0,
      )
  );
}

function validManifest(
  snapshot: AnalysisSnapshot,
  recordCount: number,
): boolean {
  const fields = record(JSON.parse(snapshot.redaction));
  if (fields === undefined || Object.keys(fields).length !== 6) return false;
  return (
    fields["schemaVersion"] === 1 &&
    fields["ruleVersion"] === 1 &&
    fields["importId"] === snapshot.importId &&
    fields["recordCount"] === recordCount &&
    validCounts(fields["counts"], fields["totalCount"])
  );
}

export function isAnalysisSnapshot(value: unknown): value is AnalysisSnapshot {
  const fields = record(value);
  return (
    fields !== undefined &&
    Object.keys(fields).length === 4 &&
    ["importId", "redaction", "corpus", "structure"].every(
      (key) => typeof fields[key] === "string",
    )
  );
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const fields = record(value);
  if (fields === undefined) return JSON.stringify(value);
  return `{${Object.keys(fields)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(fields[key])}`)
    .join(",")}}`;
}

function matchingStructure(
  value: unknown,
  records: AnalysisEvidence["records"],
): value is ImportStructure {
  const fields = record(value);
  const occurrences = fields?.["occurrences"];
  if (!Array.isArray(occurrences) || occurrences.length !== records.length)
    return false;
  const classified = records.map((message, index) => {
    const occurrence = record(occurrences[index]);
    const copy = record(occurrence?.["copyOf"]);
    return {
      ...message,
      role: "user" as const,
      text: String(copy === undefined ? index : Number(copy["recordIndex"])),
      blocks: [],
    };
  });
  return canonical(value) === canonical(structureImport(classified));
}

export function analysisEvidence(snapshot: AnalysisSnapshot): AnalysisEvidence {
  const records = parseCorpus(snapshot.corpus);
  if (!validManifest(snapshot, records.length))
    throw new Error("analysis-input-refused");
  const envelope = record(JSON.parse(snapshot.structure));
  if (
    envelope?.["schemaVersion"] !== 1 ||
    envelope["importId"] !== snapshot.importId
  )
    throw new Error("analysis-input-refused");
  const structure = Object.fromEntries(
    Object.entries(envelope).filter(
      ([key]) => !["schemaVersion", "importId"].includes(key),
    ),
  );
  if (!matchingStructure(structure, records))
    throw new Error("analysis-input-refused");
  return { records, structure };
}
