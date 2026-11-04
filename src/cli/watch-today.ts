import {
  dailyNumbers,
  type DailyNumbers,
  type ReportDay,
} from "../report-days.ts";
import type { Fields } from "../protocol.ts";
import type { ReportCompletion } from "../report.ts";
import { reportCompletion, reportCost } from "./report.ts";
import { recentRun } from "./watch-board.ts";

interface TodayRun {
  readonly status: Fields;
  readonly events: readonly Fields[];
}

function localDate(day: Date): string {
  return [day.getFullYear(), day.getMonth() + 1, day.getDate()]
    .map((part) => String(part).padStart(2, "0"))
    .join("-");
}

function localDay(clock: Date, offset: number): ReportDay {
  const [year, month, date] = [
    clock.getFullYear(),
    clock.getMonth(),
    clock.getDate() + offset,
  ];
  const start = new Date(year, month, date);
  return {
    date: localDate(start),
    start: start.getTime(),
    end: new Date(year, month, date + 1).getTime(),
  };
}

export function localDays(now: string, count: number): ReportDay[] {
  const clock = new Date(now);
  return Array.from({ length: count }, (_, index) =>
    localDay(clock, index + 1 - count),
  );
}

export function todayStart(now: string): number {
  return localDay(new Date(now), 0).start;
}

export function loadedRun(latestAt: string | null, now: string): boolean {
  const at = Date.parse(latestAt ?? "");
  const first = localDay(new Date(now), -6).start;
  return recentRun(latestAt, now) || (at >= first && at <= Date.parse(now));
}

function accepted(event: Fields): ReportCompletion | null {
  try {
    return reportCompletion(event);
  } catch {
    return null;
  }
}

function completionsOf(run: TodayRun) {
  const workflowId = String(run.status["workflowId"]);
  return run.events.flatMap((event) => {
    const completion = accepted(event);
    return completion === null ? [] : [{ ...completion, workflowId }];
  });
}

export function todayOf(input: {
  readonly now: string;
  readonly runs: readonly TodayRun[];
  readonly workflows: readonly string[];
}): DailyNumbers {
  const clock = new Date(input.now);
  return dailyNumbers({
    today: localDay(clock, 0),
    yesterday: localDay(clock, -1),
    days: localDays(input.now, 7),
    completions: input.runs.flatMap(completionsOf),
    costs: input.runs.map((run) =>
      reportCost(String(run.status["runId"]), run.status),
    ),
    workflows: input.workflows,
  });
}
