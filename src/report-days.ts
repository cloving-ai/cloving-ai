import { reportRunCosts, type ReportCost } from "./report.ts";
import type { ReportCompletion } from "./report-flow-types.ts";

export interface ReportDay {
  readonly date: string;
  readonly start: number;
  readonly end: number;
}

export interface DailyNumbers {
  readonly completed: number;
  readonly stopped: number;
  readonly costUsd: number | null;
  readonly costPerCompletedRunUsd: number | null;
  readonly yesterday: {
    readonly completed: number;
    readonly costUsd: number | null;
  };
  readonly days: readonly {
    readonly date: string;
    readonly completed: number;
  }[];
  readonly workflows: readonly {
    readonly workflowId: string;
    readonly completed: number;
    readonly costUsd: number | null;
  }[];
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

function summedCost(
  completions: readonly DayCompletion[],
  costs: readonly ReportCost[],
): number | null {
  const runs = reportRunCosts(completions, costs);
  if (runs.some((run) => run.costUsd === null)) return null;
  return runs.reduce((sum, run) => sum + Number(run.costUsd), 0);
}

export function dailyNumbers(input: DailyInput): DailyNumbers {
  const today = endedIn(input.completions, input.today);
  const yesterday = endedIn(input.completions, input.yesterday);
  const completed = completedCount(today);
  const costUsd = summedCost(today, input.costs);
  const workflowIds = new Set([
    ...input.workflows,
    ...today.map((completion) => completion.workflowId),
  ]);
  return {
    completed,
    stopped: today.filter((completion) =>
      stoppedOutcomes.includes(completion.outcome),
    ).length,
    costUsd,
    costPerCompletedRunUsd:
      completed === 0 || costUsd === null ? null : costUsd / completed,
    yesterday: {
      completed: completedCount(yesterday),
      costUsd: summedCost(yesterday, input.costs),
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
        costUsd: summedCost(own, input.costs),
      };
    }),
  };
}
