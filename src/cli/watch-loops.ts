import { record, type Fields } from "../protocol.ts";
import { send } from "./client.ts";
import {
  calendarText,
  type ShownSchedule,
  type ShownSchedules,
} from "./schedule-render.ts";

export interface WatchLoopRun {
  readonly runId: string;
  readonly state: string;
  readonly outcome: string | null;
  readonly endedAt: string | null;
}

export interface WatchLoop {
  readonly workflowId: string;
  readonly rule: string;
  readonly state: ShownSchedule["state"];
  readonly nextAt: string | null;
  readonly failuresInRow: number;
  readonly lastRun: WatchLoopRun | null;
}

interface LoopRead {
  readonly schedules?: ShownSchedules;
  readonly summaries: readonly Fields[];
  readonly runs: readonly { readonly status: Fields }[];
}

const endedStates = ["completed", "failed", "cancelled"];

export function ruleText(schedule: ShownSchedule): string {
  if ("at" in schedule) return calendarText(schedule);
  const seconds = schedule.everySeconds;
  if (seconds % 3600 === 0) return `every ${String(seconds / 3600)} h`;
  if (seconds % 60 === 0) return `every ${String(seconds / 60)} min`;
  return `every ${String(seconds)} s`;
}

function loopRun(status: Fields, workflowId: string): boolean {
  return (
    status["workflowId"] === workflowId &&
    (status["manualFromLoop"] === true ||
      record(status["scheduled"]) !== undefined)
  );
}

function latestAt(status: Fields): string {
  const at = status["latestAt"];
  return typeof at === "string" ? at : "";
}

function lastSummary(
  summaries: readonly Fields[],
  workflowId: string,
): Fields | undefined {
  return summaries
    .filter((status) => loopRun(status, workflowId))
    .toSorted((first, second) =>
      latestAt(first) < latestAt(second) ? 1 : -1,
    )[0];
}

async function fullStatus(
  runtimeDirectory: string,
  summary: Fields,
): Promise<Fields> {
  const reply = await send(runtimeDirectory, {
    operation: "status",
    parameters: { runId: summary["runId"] },
  });
  if (reply.kind === "error") return summary;
  return record(reply.result["run"]) ?? summary;
}

export async function loopRunsOf(
  runtimeDirectory: string,
  read: LoopRead,
): Promise<readonly Fields[]> {
  const { schedules } = read;
  if (schedules === undefined || "status" in schedules) return [];
  const statuses: Fields[] = [];
  for (const schedule of schedules) {
    const summary = lastSummary(read.summaries, schedule.workflowId);
    if (summary === undefined) continue;
    const loaded = read.runs.find(
      (run) => run.status["runId"] === summary["runId"],
    );
    statuses.push(
      loaded?.status ?? (await fullStatus(runtimeDirectory, summary)),
    );
  }
  return statuses;
}

function lastRunOf(status: Fields | undefined): WatchLoopRun | null {
  if (status === undefined) return null;
  const state = String(status["state"]);
  const outcome = record(status["outcome"])?.["kind"];
  return {
    runId: String(status["runId"]),
    state,
    outcome: typeof outcome === "string" ? outcome : null,
    endedAt: endedStates.includes(state) ? latestAt(status) : null,
  };
}

export function loopRows(
  schedules: ShownSchedules | undefined,
  statuses: readonly Fields[],
): readonly WatchLoop[] {
  if (schedules === undefined || "status" in schedules) return [];
  return schedules.map((schedule) => ({
    workflowId: schedule.workflowId,
    rule: ruleText(schedule),
    state: schedule.state,
    nextAt:
      schedule.nextAt === null ? null : new Date(schedule.nextAt).toISOString(),
    failuresInRow: schedule.failuresInRow,
    lastRun: lastRunOf(
      statuses.find((status) => loopRun(status, schedule.workflowId)),
    ),
  }));
}
