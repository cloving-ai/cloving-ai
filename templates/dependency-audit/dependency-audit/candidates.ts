import { runCommand } from "cloving/workflows/steps/run-command";
import {
  effectText,
  failure,
  fields,
  items,
  line,
  packageName,
  parsed,
} from "./fields.ts";

export interface AuditInput {
  readonly cycleId: string;
  readonly input: Readonly<Record<string, never>>;
}

export type Severity = "critical" | "high";

export interface Advisory {
  readonly id: string;
  readonly severity: Severity;
  readonly title: string;
  readonly url: string;
  readonly vulnerableRange: string;
  readonly patchedRange: string | null;
}

export interface Candidate {
  readonly name: string;
  readonly severity: Severity;
  readonly direct: boolean;
  readonly range: string;
  readonly versions: readonly string[];
  readonly effects: readonly string[];
  readonly fixAvailable: unknown;
  readonly advisories: readonly Advisory[];
  readonly paths: readonly string[];
  readonly pathCount: number;
}

const bad = "invalid-audit-candidates";

function text(value: unknown, maximum: number): string {
  return line(value, { reason: bad, pattern: /^/, maximum });
}

function severityOf(value: unknown): Severity {
  return value === "critical" || value === "high" ? value : failure(bad);
}

function advisoryOf(value: unknown): Advisory {
  const item = fields(value, bad);
  const patched = item["patchedRange"];
  return {
    id: line(item["id"], {
      reason: bad,
      pattern: /^(?:GHSA(?:-[0-9a-z]{4}){3}|\d+)$/i,
      maximum: 40,
    }),
    severity: severityOf(item["severity"]),
    title: line(item["title"], { reason: bad, pattern: /^\S/, maximum: 500 }),
    url: line(item["url"], {
      reason: bad,
      pattern: /^https:\/\/\S+$/,
      maximum: 300,
    }),
    vulnerableRange: text(item["vulnerableRange"], 200),
    patchedRange: patched === null ? null : text(patched, 200),
  };
}

function names(value: unknown): readonly string[] {
  return items(value, { reason: bad, minimum: 0, maximum: 50 }).map((name) =>
    line(name, { reason: bad, pattern: packageName, maximum: 214 }),
  );
}

function counted(item: Readonly<Record<string, unknown>>) {
  const paths = items(item["paths"], {
    reason: bad,
    minimum: 0,
    maximum: 20,
  }).map((path) => text(path, 500));
  const pathCount = item["pathCount"];
  if (
    typeof pathCount !== "number" ||
    !Number.isSafeInteger(pathCount) ||
    pathCount < paths.length
  )
    failure(bad);
  return { paths, pathCount };
}

function candidateOf(value: unknown): Candidate {
  const item = fields(value, bad);
  const direct = item["direct"];
  const fixAvailable = item["fixAvailable"];
  if (typeof direct !== "boolean") failure(bad);
  if (typeof fixAvailable !== "boolean") fields(fixAvailable, bad);
  const { paths, pathCount } = counted(item);
  return {
    name: line(item["name"], {
      reason: bad,
      pattern: packageName,
      maximum: 214,
    }),
    severity: severityOf(item["severity"]),
    direct,
    range: text(item["range"], 200),
    versions: items(item["versions"], {
      reason: bad,
      minimum: 0,
      maximum: 20,
    }).map((version) => text(version, 100)),
    effects: names(item["effects"]),
    fixAvailable,
    advisories: items(item["advisories"], {
      reason: bad,
      minimum: 1,
      maximum: 20,
    }).map((advisory) => advisoryOf(advisory)),
    paths,
    pathCount,
  };
}

export async function auditCandidates(): Promise<readonly Candidate[]> {
  const input: Readonly<Record<string, never>> = {};
  const output = effectText(
    await runCommand({
      scope: { phase: "audit", operation: "audit-candidates", round: 1 },
      name: "audit-candidates",
      input: input,
    }),
    bad,
  );
  return items(parsed(output, bad), {
    reason: bad,
    minimum: 0,
    maximum: 10,
  }).map((value) => candidateOf(value));
}
