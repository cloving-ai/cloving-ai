import type { ReviewFacts } from "./facts.ts";

type Entry = readonly [string, unknown];

export const promptBytes = 48000;

const lists = ["reviews", "report.runCosts.mostCostly", "improvements"];

const units = [
  ["Minutes", "minutes"],
  ["Hours", "hours"],
  ["Usd", "usd"],
  ["Share", "share"],
  ["reviewScore", "score"],
] as const;

const runFields = [
  "runId",
  "ticketId",
  "outcome",
  "completedAt",
  "costUsd",
  "mark",
];

function entries(value: unknown): readonly Entry[] {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.entries(value)
    : [];
}

function field(value: unknown, name: string): unknown {
  return entries(value).find(([key]) => key === name)?.[1] ?? null;
}

function compactField(entry: Entry): Entry {
  const [key, value] = entry;
  if (key === "evidence")
    return ["count", Array.isArray(value) ? value.length : null];
  if (key !== "baseline" || entries(value).length === 0) return entry;
  return [
    key,
    Object.fromEntries(entries(value).filter(([name]) => name !== "evidence")),
  ];
}

function compactMetric(name: string, metric: unknown) {
  return Object.fromEntries(
    entries(metric)
      .map((entry) => compactField(entry))
      .concat([
        ["unit", units.find(([part]) => name.includes(part))?.[1] ?? "count"],
      ]),
  );
}

function metricEntries(section: unknown, prefix: string): readonly Entry[] {
  return entries(section).flatMap(([name, value]) => {
    const key = prefix + name;
    if (entries(value).some(([part]) => part === "value"))
      return [[key, compactMetric(key, value)] as const];
    return metricEntries(value, `${key}.`);
  });
}

function costTotals(runCosts: unknown) {
  if (!Array.isArray(runCosts)) return null;
  const runs: readonly unknown[] = runCosts;
  const known = runs.flatMap((run) => {
    const cost = field(run, "costUsd");
    return typeof cost === "number" ? [{ run, cost }] : [];
  });
  return {
    runs: runs.length,
    knownSpendUsd: known.reduce((sum, item) => sum + item.cost, 0),
    runsWithoutCost: runs.length - known.length,
    mostCostly: known
      .toSorted((left, right) => right.cost - left.cost)
      .slice(0, 5)
      .map((item) =>
        Object.fromEntries(
          entries(item.run).filter(([key]) => runFields.includes(key)),
        ),
      ),
  };
}

function compactReport(report: ReviewFacts["report"]) {
  return {
    window: report["window"] ?? null,
    semantics: report["semantics"] ?? null,
    metrics: Object.fromEntries(
      metricEntries(report["metrics"], "").concat(
        metricEntries(report["quality"], "quality."),
        metricEntries(report["ci"], "ci."),
        metricEntries(report["operator"], "operator."),
      ),
    ),
    jobLogs: field(report["quality"], "jobLogs"),
    runCosts: costTotals(report["runCosts"]),
  };
}

function withoutRuns(report: ReturnType<typeof compactReport>) {
  return Object.assign({}, report, {
    runCosts:
      report.runCosts === null
        ? null
        : Object.assign({}, report.runCosts, { mostCostly: null }),
  });
}

export function utf8Bytes(text: string): number {
  return encodeURIComponent(text).replace(/%[0-9A-F]{2}/g, "x").length;
}

export function turnFacts(facts: ReviewFacts): readonly unknown[] {
  const report = compactReport(facts.report);
  return [0, 1, 2, 3].map((count) => {
    const omitted = lists.slice(0, count);
    return {
      report: omitted.includes("report.runCosts.mostCostly")
        ? withoutRuns(report)
        : report,
      reviews: omitted.includes("reviews") ? null : facts.reviews,
      improvements: omitted.includes("improvements")
        ? null
        : facts.improvements,
      omitted,
    };
  });
}
