import { reportRunCosts, type ReportCost } from "./report.ts";
import type { ReportCompletion } from "./report-flow-types.ts";

export interface ReportDay {
  readonly date: string;
  readonly start: number;
  readonly end: number;
}

export interface KnownSpend {
  readonly costUsd: number;
  readonly unknownCostRuns: number;
}

export interface DailyNumbers extends KnownSpend {
  readonly completed: number;
  readonly stopped: number;
  readonly costPerCompletedRunUsd: number | null;
  readonly yesterday: KnownSpend & { readonly completed: number };
  readonly days: readonly {
    readonly date: string;
    readonly completed: number;
  }[];
  readonly workflows: readonly (KnownSpend & {
    readonly workflowId: string;
    readonly completed: number;
  })[];
}

type DayCompletion = ReportCompletion & { readonly workflowId: string };

interface DailyInput {
  readonly today: ReportDay;
  readonly yesterday: ReportDay;
  readonly days: readonly ReportDay[];
  readonly completions: readonly DayCompletion[];
  readonly costs: readonly ReportCost[];
  readonly workflows: readonly string[];
}

const stoppedOutcomes: readonly string[] = ["failed", "cancelled", "blocked"];

function endedIn(
  completions: readonly DayCompletion[],
  day: ReportDay,
): readonly DayCompletion[] {
  return completions.filter(
    (completion) => completion.at >= day.start && completion.at < day.end,
  );
}

function completedCount(completions: readonly DayCompletion[]): number {
  return completions.filter((completion) => completion.outcome === "completed")
    .length;
}

function knownSpend(
  completions: readonly DayCompletion[],
  costs: readonly ReportCost[],
): KnownSpend {
  const runs = reportRunCosts(completions, costs);
  return {
    costUsd: runs.reduce((sum, run) => sum + (run.costUsd ?? 0), 0),
    unknownCostRuns: runs.filter((run) => run.costUsd === null).length,
  };
}

function costPerCompletedRun(
  completions: readonly DayCompletion[],
  costs: readonly ReportCost[],
): number | null {
  const known = reportRunCosts(
    completions.filter((completion) => completion.outcome === "completed"),
    costs,
  ).filter((run) => run.costUsd !== null).length;
  return known === 0 ? null : knownSpend(completions, costs).costUsd / known;
}

export function dailyNumbers(input: DailyInput): DailyNumbers {
  const today = endedIn(input.completions, input.today);
  const yesterday = endedIn(input.completions, input.yesterday);
  const completed = completedCount(today);
  const workflowIds = new Set([
    ...input.workflows,
    ...today.map((completion) => completion.workflowId),
  ]);
  return {
    completed,
    stopped: today.filter((completion) =>
      stoppedOutcomes.includes(completion.outcome),
    ).length,
    ...knownSpend(today, input.costs),
    costPerCompletedRunUsd: costPerCompletedRun(today, input.costs),
    yesterday: {
      completed: completedCount(yesterday),
      ...knownSpend(yesterday, input.costs),
    },
    days: input.days.map((day) => ({
      date: day.date,
      completed: completedCount(endedIn(input.completions, day)),
    })),
    workflows: [...workflowIds].map((workflowId) => {
      const own = today.filter(
        (completion) => completion.workflowId === workflowId,
      );
      return {
        workflowId,
        completed: completedCount(own),
        ...knownSpend(own, input.costs),
      };
    }),
  };
}
