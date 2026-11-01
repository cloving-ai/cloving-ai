import {
  reportQualityMetrics,
  type ReportQualityData,
} from "./report-quality.ts";
import {
  reportMetric,
  outsideReportBand,
  type ReportDatum,
  type ReportWindow,
} from "./report-statistics.ts";
import { reportOperatorMetrics } from "./report-operator.ts";
import { reportCiMetrics, type ReportCiData } from "./report-ci.ts";
import { reportEffectData } from "./report-effects.ts";
import { reportFlowMetrics } from "./report-flow.ts";
import type { ReportFlow } from "./report-flow-types.ts";
import type { ReportReadyTicket } from "./report-flow-types.ts";
import type { Fields } from "./protocol.ts";

import { reportOutcomes, type ReportCompletion } from "./report-flow-types.ts";
export {
  reportOutcomes,
  type ReportCompletion,
  type ReportOutcome,
} from "./report-flow-types.ts";

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
  readonly flow?: ReportFlow;
  readonly effects?: readonly Fields[] | null;
  readonly since: number;
  readonly now: number;
  readonly completions: readonly ReportCompletion[] | null;
  readonly observedSince?: number | null;
  readonly costs?: readonly ReportCost[];
  readonly github?: ReportQualityData & {
    readonly labels?: readonly ReportDatum[] | null;
    readonly ciUsage?: ReportCiData | null;
    readonly mainFirstPass?: readonly ReportDatum[] | null;
    readonly observedSince?: number | null;
    readonly issues: readonly ReportDatum[] | null;
    readonly pulls: readonly ReportDatum[] | null;
    readonly ready?: readonly ReportReadyTicket[] | null;
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
  const data = reportEffectData(input.effects ?? null);
  const metrics: Record<string, ReturnType<typeof reportMetric>> = {
    "fixRounds.medianPerMergedPullRequest": reportMetric({
      data: data.fixRounds,
      window,
      aggregation: "median",
    }),
  };
  for (const phase of ["workerTurn", "codeReview", "merge"] as const)
    metrics[`phases.${phase}.medianMinutes`] = reportMetric({
      data: data[phase],
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
  const costs = reportRunCosts(
    (input.completions ?? []).filter((event) => event.at < window.end),
    input.costs ?? [],
  );
  const tickets = completedCosts(
    (input.github?.issues ?? []).filter((issue) => issue.at < window.end),
    costs,
  );
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
    ...reportFlowMetrics(
      {
        flow: input.flow,
        completions: input.completions,
        ready: {
          tickets: input.github?.ready ?? null,
          observedSince: input.github?.observedSince ?? null,
        },
      },
      window,
    ),
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

function operatorMetrics(input: ReportInput, window: ReportWindow) {
  return reportOperatorMetrics(
    {
      effects: input.effects ?? null,
      pulls: input.github?.pulls ?? null,
      labels: input.github?.labels ?? null,
    },
    {
      ...window,
      observedSince: commonHistory(
        window.observedSince,
        input.github?.observedSince ?? null,
      ),
    },
  );
}

function operatingMetrics(input: ReportInput, window: ReportWindow) {
  return {
    ci: reportCiMetrics(input.github?.ciUsage ?? undefined, {
      ...window,
      observedSince: input.github?.observedSince ?? null,
    }),
    operator: operatorMetrics(input, window),
  };
}

export function loopReport(input: ReportInput) {
  const end = input.now;
  const start = end - input.since * 3_600_000;
  const window = { start, end, observedSince: input.observedSince ?? null };
  return {
    schemaVersion: 1,
    kind: "loop-report",
    window: { start, end, hours: input.since },
    semantics: {
      tickets: "closed-completed-in-window",
      flowLanes: "current-queue-workflow-and-lane-setting",
      flowTickets:
        "ready-label-intervals-and-current-ticket-body-dependency-close-times",
      flowIdle:
        "elapsed-hours-with-spare-capacity-and-at-least-one-eligible-ticket",
      flowWait: "sum-of-ticket-hours-by-dependency-or-full-lanes",
      flowStreak:
        "terminal-time-then-sequence;current-carries-history;longest-counts-window-ends",
      operatorLabels: "time-match-within-2-minutes-for-same-issue",
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
    quality: reportQualityMetrics(
      {
        ...input.github,
        effects: input.effects ?? null,
        daemonObservedSince: input.observedSince ?? null,
      },
      { ...window, observedSince: input.github?.observedSince ?? null },
    ),
    ...operatingMetrics(input, window),
    coverage: {},
  };
}

export function reportRunCosts(
  completions: readonly ReportCompletion[],
  costs: readonly ReportCost[],
) {
  const byRun = new Map<string, ReportCost>();
  for (const cost of costs)
    if (!byRun.has(cost.runId)) byRun.set(cost.runId, cost);
  return completions.map((event) => {
    const cost = byRun.get(event.runId);
    const turns = cost?.turns ?? null;
    const known =
      turns !== null && turns.every((turn) => turn.costUsd !== null);
    const total = known
      ? turns.reduce((sum, turn) => sum + (turn.costUsd ?? 0), 0)
      : null;
    return {
      runId: event.runId,
      ticketId: cost?.ticketId,
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
  completed: readonly ReportDatum[],
  costs: ReturnType<typeof reportRunCosts>,
) {
  const issues = new Map(
    completed
      .toSorted((left, right) => left.at - right.at)
      .map((issue) => [issue.evidence["issue"], issue]),
  );
  return [...issues.values()].map((issue) => {
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
