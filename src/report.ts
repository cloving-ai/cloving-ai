import {
  reportMetric,
  outsideReportBand,
  type ReportDatum,
  type ReportWindow,
} from "./report-statistics.ts";
import { reportFixRounds, reportPhaseTimes } from "./report-effects.ts";
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
  readonly ticketId?: string | null;
  readonly turns:
    | readonly {
        readonly operationId: string;
        readonly costUsd: number | null;
        readonly estimatedCostUsd?: number;
      }[]
    | null;
}

interface ReportInput {
  readonly effects?: readonly Fields[] | null;
  readonly since: number;
  readonly now: number;
  readonly completions: readonly ReportCompletion[] | null;
  readonly observedSince?: number | null;
  readonly costs?: readonly ReportCost[];
  readonly github?: {
    readonly observedSince?: number | null;
    readonly issues: readonly ReportDatum[] | null;
    readonly pulls: readonly ReportDatum[] | null;
    readonly leadTimes?: readonly ReportDatum[] | null;
    readonly sources: Fields;
  };
}

function outcomeMetrics(
  input: ReportInput,
  window: ReportWindow,
): Record<string, ReturnType<typeof reportMetric>> {
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

function effectMetrics(input: ReportInput, window: ReportWindow) {
  const metrics: Record<string, ReturnType<typeof reportMetric>> = {
    "fixRounds.medianPerMergedPullRequest": reportMetric({
      data: reportFixRounds(input.effects ?? null),
      window,
      aggregation: "median",
    }),
  };
  for (const [phase, method] of [
    ["workerTurn", "run-turn"],
    ["codeReview", "wait-review"],
    ["merge", "merge"],
  ])
    metrics[`phases.${String(phase)}.medianMinutes`] = reportMetric({
      data: reportPhaseTimes(input.effects ?? null, String(method)),
      window,
      aggregation: "median",
    });
  return metrics;
}

function githubMetrics(input: ReportInput, window: ReportWindow) {
  const observed = {
    ...window,
    observedSince: input.github?.observedSince ?? null,
  };
  return {
    "leadTime.medianHours": reportMetric({
      data: input.github?.leadTimes ?? null,
      window: observed,
      aggregation: "median",
    }),
    "tickets.completed": reportMetric({
      data: input.github?.issues ?? null,
      window: observed,
      aggregation: "count",
    }),
    "pullRequests.merged": reportMetric({
      data: input.github?.pulls ?? null,
      window: observed,
      aggregation: "count",
    }),
  };
}

function ticketCostMetric(input: ReportInput, window: ReportWindow) {
  const costs = reportRunCosts(input.completions ?? [], input.costs ?? []);
  const tickets = completedCosts(input, costs);
  const metric = reportMetric({
    data:
      input.completions === null || input.github?.issues == null
        ? null
        : tickets.map((ticket) => ({
            at: ticket.closedAt,
            value: ticket.costUsd,
            evidence: ticket.evidence,
          })),
    window: {
      ...window,
      observedSince: commonHistory(
        window.observedSince,
        input.github?.observedSince ?? null,
      ),
    },
    aggregation: "median",
  });
  const completedTicketCosts = tickets
    .filter(
      (ticket) =>
        ticket.closedAt >= window.start && ticket.closedAt < window.end,
    )
    .map((ticket) => ({
      ...ticket,
      ...costHistory(ticket.costUsd, metric.baseline),
    }));
  return { metric, completedTicketCosts };
}

function costHistory(
  cost: number | null,
  baseline: ReturnType<typeof reportMetric>["baseline"],
) {
  return {
    baseline,
    ...(outsideReportBand(cost, baseline.band) ? { mark: "outside" } : {}),
  };
}

function metricCollection(input: ReportInput, window: ReportWindow) {
  const costs = reportRunCosts(input.completions ?? [], input.costs ?? []);
  const tickets = ticketCostMetric(input, window);
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
  const metrics = {
    ...outcomeMetrics(input, window),
    ...effectMetrics(input, window),
    ...githubMetrics(input, window),
    "cost.medianRunUsd": costMetric,
    "cost.medianCompletedTicketUsd": tickets.metric,
  };
  const runCosts = costs
    .filter(
      (cost) =>
        cost.completedAt >= window.start && cost.completedAt < window.end,
    )
    .map((cost) => ({
      ...cost,
      ...costHistory(cost.costUsd, costMetric.baseline),
    }));
  return {
    metrics,
    runCosts,
    completedTicketCosts: tickets.completedTicketCosts,
  };
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
      ticketClosureHistory: unavailable,
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
      ticketId: costs.find((cost) => cost.runId === event.runId)?.ticketId,
      outcome: event.outcome,
      completedAt: event.at,
      costUsd: total !== null && Number.isFinite(total) ? total : null,
      turns,
      evidence: { runId: event.runId, sequence: event.sequence },
    };
  });
}

function commonHistory(
  daemon: number | null,
  github: number | null,
): number | null {
  return daemon === null || github === null ? null : Math.max(daemon, github);
}

function completedCosts(
  input: ReportInput,
  costs: ReturnType<typeof reportRunCosts>,
) {
  return (input.github?.issues ?? []).map((issue) => {
    const number = issue.evidence["issue"];
    const runs = costs.filter((cost) => cost.ticketId === String(number));
    const unknown =
      costs.some((cost) => cost.ticketId === undefined) ||
      runs.length === 0 ||
      runs.some((run) => run.costUsd === null);
    const total = unknown
      ? null
      : runs.reduce((sum, run) => sum + (run.costUsd ?? 0), 0);
    return {
      issue: number,
      closedAt: issue.at,
      costUsd: total !== null && Number.isFinite(total) ? total : null,
      runs,
      evidence: { issue: number, runIds: runs.map((run) => run.runId) },
    };
  });
}
