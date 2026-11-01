import type { loopReport } from "../report.ts";
import type { reportMetric } from "../report-statistics.ts";

type Metric = ReturnType<typeof reportMetric>;
type MetricGroup = Readonly<Record<string, Metric>>;
type MetricSection = Readonly<Record<string, Metric | MetricGroup>>;
type TextReport = Omit<ReturnType<typeof loopReport>, "window" | "runCosts"> & {
  readonly window: Readonly<Record<string, string | number>>;
  readonly runCosts: readonly unknown[];
};

function isMetric(value: Metric | MetricGroup): value is Metric {
  return typeof value["status"] === "string";
}

function sectionMetrics(section: MetricSection, prefix: string): MetricGroup {
  return Object.fromEntries(
    Object.entries(section).flatMap(([name, value]) =>
      isMetric(value)
        ? [[`${prefix}.${name}`, value] as const]
        : Object.entries(value).map(
            ([key, metric]) => [`${prefix}.${name}.${key}`, metric] as const,
          ),
    ),
  );
}

export function textReport(report: TextReport): string {
  const lines = [`Loop report ${JSON.stringify(report.window)}`];
  const { jobLogs, ...quality } = report.quality;
  const metrics = {
    ...report.metrics,
    ...sectionMetrics(quality, "quality"),
    ...sectionMetrics(report.ci, "ci"),
    ...sectionMetrics(report.operator, "operator"),
  };
  for (const [name, metric] of Object.entries(metrics)) {
    lines.push(
      `${name}: ${metric.status === "unavailable" ? "unavailable" : String(metric.value)}`,
    );
    const baseline = metric.baseline;
    lines.push(
      `  history: ${baseline.history}; median: ${String(baseline.median)}; band: ${JSON.stringify(baseline.band)}${metric.mark === "outside" ? "; outside" : ""}`,
    );
    lines.push(`  comparison value: ${String(metric.comparisonValue)}`);
    lines.push(`  evidence: ${JSON.stringify(metric.evidence)}`);
    lines.push(`  baseline evidence: ${JSON.stringify(baseline.evidence)}`);
  }
  lines.push(`Quality job logs: ${JSON.stringify(jobLogs)}`);
  lines.push(`Run costs (USD): ${JSON.stringify(report.runCosts)}`);
  lines.push(
    `Completed ticket costs (USD): ${JSON.stringify(report.completedTicketCosts)}`,
  );
  lines.push(`Semantics: ${JSON.stringify(report.semantics)}`);
  lines.push(`Sources: ${JSON.stringify(report.sources)}`);
  lines.push(`Coverage: ${JSON.stringify(report.coverage)}`);
  return lines.join("\n") + "\n";
}
