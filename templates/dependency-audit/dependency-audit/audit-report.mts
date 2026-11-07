import { inRange, patchedRange } from "./audit-ranges.mts";

export type Severity = "critical" | "high";

export interface AuditAdvisory {
  readonly id: string;
  readonly severity: Severity;
  readonly title: string;
  readonly url: string;
  readonly vulnerableRange: string;
  readonly patchedRange: string | null;
}

export type Fix =
  | boolean
  | {
      readonly name: string;
      readonly version: string;
      readonly isSemVerMajor: boolean;
    };

export interface AuditCandidate {
  readonly name: string;
  readonly severity: Severity;
  readonly direct: boolean;
  readonly range: string;
  readonly versions: readonly string[];
  readonly effects: readonly string[];
  readonly fixAvailable: Fix;
  readonly advisories: readonly AuditAdvisory[];
  readonly advisoryCount: number;
  readonly paths: readonly string[];
  readonly pathCount: number;
}

interface Installed {
  readonly name: string;
  readonly version: string;
  readonly path: string;
  readonly depth: number;
}

type Fields = Readonly<Record<string, unknown>>;

export const auditLimits = {
  packages: 10,
  paths: 20,
  pathLength: 500,
  advisories: 20,
  versions: 20,
  effects: 50,
};

function shortened(path: string): string {
  return path.length <= auditLimits.pathLength
    ? path
    : `${path.slice(0, auditLimits.pathLength - 1)}…`;
}

function unexpected(source: string): Error {
  return new Error(`${source} printed an unexpected report.`);
}

function fields(value: unknown, source: string): Fields {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw unexpected(source);
  return Object.fromEntries(Object.entries(value));
}

function list(value: unknown, source: string): readonly unknown[] {
  if (!Array.isArray(value)) throw unexpected(source);
  return value.map((item: unknown) => item);
}

function text(value: unknown, source: string): string {
  if (typeof value !== "string") throw unexpected(source);
  return value;
}

function advisoryOf(via: unknown): AuditAdvisory | undefined {
  if (typeof via === "string") return undefined;
  const item = fields(via, "npm audit");
  const severity = text(item["severity"], "npm audit");
  const url = text(item["url"], "npm audit");
  const vulnerableRange = text(item["range"], "npm audit");
  const title = text(item["title"], "npm audit");
  const source = item["source"];
  if (typeof source !== "number") throw unexpected("npm audit");
  if (severity !== "critical" && severity !== "high") return undefined;
  return {
    id: /\bGHSA(?:-[0-9a-z]{4}){3}\b/i.exec(url)?.[0] ?? String(source),
    severity,
    title,
    url,
    vulnerableRange,
    patchedRange: patchedRange(vulnerableRange),
  };
}

function fixOf(value: unknown): Fix {
  if (typeof value === "boolean") return value;
  const fix = fields(value, "npm audit");
  const isSemVerMajor = fix["isSemVerMajor"];
  if (typeof isSemVerMajor !== "boolean") throw unexpected("npm audit");
  return {
    name: text(fix["name"], "npm audit"),
    version: text(fix["version"], "npm audit"),
    isSemVerMajor,
  };
}

function named(id: string, texts: readonly string[]): boolean {
  const pattern = new RegExp(`(?<![\\w-])${id}(?![\\w-])`, "i");
  return texts.some((item) => pattern.test(item));
}

function issueTexts(pages: unknown): readonly string[] {
  return list(pages, "gh").flatMap((page) =>
    list(page, "gh").flatMap((value) => {
      const issue = fields(value, "gh");
      const body = issue["body"] ?? "";
      return issue["pull_request"] === undefined
        ? [`${text(issue["title"], "gh")}\n${text(body, "gh")}`]
        : [];
    }),
  );
}

function installed(tree: unknown): readonly Installed[] {
  const found: Installed[] = [];
  const visit = (node: Fields, trail: readonly string[]): void => {
    if (node["dependencies"] === undefined) return;
    const children = fields(node["dependencies"], "npm ls");
    for (const [name, value] of Object.entries(children)) {
      const child = fields(value, "npm ls");
      const version = child["version"];
      if (typeof version !== "string") continue;
      const path = trail.concat(`${name}@${version}`);
      found.push({ name, version, path: path.join(" > "), depth: path.length });
      visit(child, path);
    }
  };
  visit(fields(tree, "npm ls"), []);
  return found.toSorted(
    (left, right) =>
      left.depth - right.depth || (left.path < right.path ? -1 : 1),
  );
}

function candidateOf(
  value: unknown,
  context: {
    readonly issues: readonly string[];
    readonly installed: readonly Installed[];
  },
): AuditCandidate | undefined {
  const vulnerability = fields(value, "npm audit");
  const name = text(vulnerability["name"], "npm audit");
  const range = text(vulnerability["range"], "npm audit");
  const direct = vulnerability["isDirect"];
  if (typeof direct !== "boolean") throw unexpected("npm audit");
  const advisories = list(vulnerability["via"], "npm audit").flatMap((via) => {
    const advisory = advisoryOf(via);
    return advisory === undefined || named(advisory.id, context.issues)
      ? []
      : [advisory];
  });
  const unique = advisories.filter(
    (advisory, index) =>
      advisories.findIndex((other) => other.id === advisory.id) === index,
  );
  if (unique.length === 0) return undefined;
  const places = context.installed.filter(
    (item) => item.name === name && inRange(item.version, range) !== false,
  );
  return {
    name,
    severity: unique.some((advisory) => advisory.severity === "critical")
      ? "critical"
      : "high",
    direct,
    range,
    versions: [...new Set(places.map((item) => item.version))]
      .sort()
      .slice(0, auditLimits.versions),
    effects: list(vulnerability["effects"], "npm audit")
      .map((item) => text(item, "npm audit"))
      .slice(0, auditLimits.effects),
    fixAvailable: fixOf(vulnerability["fixAvailable"]),
    advisories: unique
      .toSorted(
        (left, right) =>
          Number(left.severity !== "critical") -
          Number(right.severity !== "critical"),
      )
      .slice(0, auditLimits.advisories),
    advisoryCount: unique.length,
    paths: places
      .slice(0, auditLimits.paths)
      .map((item) => shortened(item.path)),
    pathCount: places.length,
  };
}

export function auditCandidates(reports: {
  readonly audit: unknown;
  readonly tree: unknown;
  readonly issues: unknown;
}): readonly AuditCandidate[] {
  const audit = fields(reports.audit, "npm audit");
  if (audit["auditReportVersion"] !== 2) throw unexpected("npm audit");
  const context = {
    issues: issueTexts(reports.issues),
    installed: installed(reports.tree),
  };
  return Object.values(fields(audit["vulnerabilities"], "npm audit"))
    .flatMap((value) => {
      const candidate = candidateOf(value, context);
      return candidate === undefined ? [] : [candidate];
    })
    .toSorted(
      (left, right) =>
        Number(left.severity !== "critical") -
          Number(right.severity !== "critical") ||
        (left.name < right.name ? -1 : 1),
    )
    .slice(0, auditLimits.packages);
}
