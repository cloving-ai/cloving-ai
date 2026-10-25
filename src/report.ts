import {
  reportMetric,
  outsideReportBand,
  type ReportDatum,
  type ReportWindow,
} from "./report-statistics.ts";
import type { Fields } from "./protocol.ts";

export const reportOutcomes = [
  "completed",
  "partial",
  "blocked",
  "failed",
  "cancelled",
] as const;
export type ReportOutcome = (typeof reportOutcomes)[number];

export interface ReportCompletion {
  readonly runId: string;
  readonly sequence: number;
  readonly at: number;
  readonly outcome: ReportOutcome;
}

export interface ReportCost {
  readonly runId: string;
  readonly turns:
    | readonly {
        readonly operationId: string;
        readonly costUsd: number | null;
        readonly estimatedCostUsd?: number;
      }[]
    | null;
}

interface ReportInput {
  readonly since: number;
  readonly now: number;
  readonly completions: readonly ReportCompletion[] | null;
  readonly observedSince?: number | null;
  readonly costs?: readonly ReportCost[];
  readonly github?: {
    readonly observedSince?: number | null;
    readonly issues: readonly ReportDatum[] | null;
    readonly pulls: readonly ReportDatum[] | null;
    readonly sources: Fields;
  };
}

function outcomeMetrics(
  input: ReportInput,
  window: ReportWindow,
): Record<string, unknown> {
  return Object.fromEntries(
    reportOutcomes.map((outcome) => {
      const data =
        input.completions === null
          ? null
          : input.completions
              .filter((event) => event.outcome === outcome)
              .map((event) => ({
                at: event.at,
                value: 1,
                evidence: { runId: event.runId, sequence: event.sequence },
              }));
      return [
        `runs.${outcome}`,
        reportMetric({ data, window, aggregation: "count" }),
      ];
    }),
  );
}

function metricCollection(input: ReportInput, window: ReportWindow) {
  const costs = reportRunCosts(input.completions ?? [], input.costs ?? []);
  const metrics = outcomeMetrics(input, window);
  const costMetric = reportMetric({
    data:
      input.completions === null
        ? null
        : costs.map((cost) => ({
            at: cost.completedAt,
            value: cost.costUsd,
            evidence: cost.evidence,
          })),
    window,
    aggregation: "median",
  });
  metrics["cost.medianRunUsd"] = costMetric;
  const githubWindow = {
    ...window,
    observedSince: input.github?.observedSince ?? null,
  };
  metrics["tickets.completed"] = reportMetric({
    data: input.github?.issues ?? null,
    window: githubWindow,
    aggregation: "count",
  });
  metrics["pullRequests.merged"] = reportMetric({
    data: input.github?.pulls ?? null,
    window: githubWindow,
    aggregation: "count",
  });
  const runCosts = costs
    .filter(
      (cost) =>
        cost.completedAt >= window.start && cost.completedAt < window.end,
    )
    .map((cost) => ({
      ...cost,
      baseline: costMetric.baseline,
      ...(outsideReportBand(cost.costUsd, costMetric.baseline.band)
        ? { mark: "outside" }
        : {}),
    }));
  return { metrics, runCosts };
}

export function loopReport(input: ReportInput) {
  const end = input.now;
  const start = end - input.since * 3_600_000;
  const window = { start, end, observedSince: input.observedSince ?? null };
  const unavailable = { status: "unavailable", reason: "not-implemented" };
  return {
    schemaVersion: 1,
    kind: "loop-report",
    window: { start, end, hours: input.since },
    semantics: {
      tickets: "currently-closed-completed",
      costs: "lifetime-turn-cost-attributed-at-run-end",
    },
    ...metricCollection(input, window),
    sources: {
      daemon: {
        status: input.completions === null ? "unavailable" : "available",
      },
      github: input.github?.sources ?? {
        issues: { status: "unavailable" },
        pulls: { status: "unavailable" },
        history: { status: "unavailable" },
      },
    },
    coverage: {
      ci: unavailable,
      flow: unavailable,
      quality: unavailable,
      operator: unavailable,
      phases: unavailable,
      fixRounds: unavailable,
      leadTime: unavailable,
      ticketClosureHistory: unavailable,
      completedTicketCosts: unavailable,
    },
  };
}

export function reportRunCosts(
  completions: readonly ReportCompletion[],
  costs: readonly ReportCost[],
) {
  return completions.map((event) => {
    const turns =
      costs.find((cost) => cost.runId === event.runId)?.turns ?? null;
    const known =
      turns !== null && turns.every((turn) => turn.costUsd !== null);
    const total = known
      ? turns.reduce((sum, turn) => sum + (turn.costUsd ?? 0), 0)
      : null;
    return {
      runId: event.runId,
      outcome: event.outcome,
      completedAt: event.at,
      costUsd: total !== null && Number.isFinite(total) ? total : null,
      turns,
      evidence: { runId: event.runId, sequence: event.sequence },
    };
  });
}
