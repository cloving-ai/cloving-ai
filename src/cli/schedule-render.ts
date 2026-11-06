import { record, type Fields } from "../protocol.ts";

interface ShownCalendar {
  readonly at: string;
  readonly timeZone: string;
  readonly weekdays?: readonly string[];
  readonly nextLocal: string | null;
}

type ShownCadence = { readonly everySeconds: number } | ShownCalendar;

export function dayText(weekdays: readonly string[] | undefined): string {
  const names = (weekdays ?? []).map(
    (day) => `${day.charAt(0).toUpperCase()}${day.slice(1)}s`,
  );
  const last = names.at(-1);
  if (last === undefined) return "each day";
  const others = names.slice(0, -1);
  if (others.length === 0) return last;
  return `${others.join(", ")} and ${last}`;
}

export function calendarText(schedule: ShownCalendar): string {
  return `${dayText(schedule.weekdays)} at ${schedule.at} ${schedule.timeZone}`;
}

function shownWeekdays(
  value: unknown,
): { readonly weekdays?: readonly string[] } | undefined {
  if (value === undefined) return {};
  if (!Array.isArray(value) || !value.every((day) => typeof day === "string"))
    return undefined;
  return { weekdays: value };
}

function shownCadence(schedule: Fields): ShownCadence | undefined {
  const { everySeconds, at, timeZone, weekdays, nextLocal } = schedule;
  if (typeof everySeconds === "number") return { everySeconds };
  const days = shownWeekdays(weekdays);
  if (
    typeof at !== "string" ||
    typeof timeZone !== "string" ||
    days === undefined
  )
    return undefined;
  return {
    at,
    timeZone,
    ...days,
    nextLocal: typeof nextLocal === "string" ? nextLocal : null,
  };
}

function listedTiming(schedule: Fields): {
  readonly every: string;
  readonly next: string;
} {
  const cadence = shownCadence(schedule);
  if (cadence !== undefined && "at" in cadence)
    return { every: calendarText(cadence), next: cadence.nextLocal ?? "none" };
  const nextAt = schedule["nextAt"];
  return {
    every: `every ${String(schedule["everySeconds"])} seconds`,
    next: typeof nextAt === "number" ? new Date(nextAt).toISOString() : "none",
  };
}

function line(value: unknown): string {
  const schedule = record(value) ?? {};
  const runId = schedule["activeRunId"];
  const activeRun = typeof runId === "string" ? runId : "none";
  const { every, next } = listedTiming(schedule);
  return `  ${String(schedule["workflowId"])}  ${every}  ${String(schedule["state"])}  next ${next}  ${String(schedule["failuresInRow"])} failures in a row  slot ${String(schedule["lastSlot"])}  active run ${activeRun}`;
}

export function scheduleLines(result: Fields): readonly string[] {
  if (result["kind"] === "schedule") return [line(result["schedule"])];
  const schedules = result["schedules"];
  const lines = Array.isArray(schedules) ? schedules.map(line) : [];
  return ["Schedules:", ...(lines.length === 0 ? ["  none"] : lines)];
}

export type ShownSchedule = ShownCadence & {
  readonly workflowId: string;
  readonly state: "active" | "paused" | "stopped";
  readonly failuresInRow: number;
  readonly nextAt: number | null;
  readonly stoppedAt: number | null;
};

export function scheduleStatusLine(
  schedule: ShownSchedule,
  style: "status" | "watch" = "status",
): string {
  const time = (at: number): string =>
    style === "watch"
      ? new Date(at).toLocaleString()
      : new Date(at).toISOString();
  const local = "at" in schedule ? schedule.nextLocal : null;
  const next =
    schedule.state === "active" && schedule.nextAt !== null
      ? `, next run at ${local ?? time(schedule.nextAt)}`
      : "";
  const stopped =
    schedule.state === "stopped" && schedule.stoppedAt !== null
      ? `, stopped at ${time(schedule.stoppedAt)}`
      : "";
  const every =
    "at" in schedule
      ? calendarText(schedule)
      : `every ${String(schedule.everySeconds)} s`;
  return `Schedule ${schedule.workflowId}: ${every}, ${schedule.state}${next}${stopped}, ${String(schedule.failuresInRow)} failures in a row`;
}

export type ShownSchedules =
  readonly ShownSchedule[] | { readonly status: "unavailable" };

export function shownSchedules(value: unknown): ShownSchedules {
  if (record(value)?.["status"] === "unavailable")
    return { status: "unavailable" };
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) => {
    const schedule = record(entry);
    const cadence = schedule === undefined ? undefined : shownCadence(schedule);
    if (
      typeof schedule?.["workflowId"] !== "string" ||
      cadence === undefined ||
      typeof schedule["failuresInRow"] !== "number"
    )
      return [];
    const state = schedule["state"];
    if (state !== "active" && state !== "paused" && state !== "stopped")
      return [];
    const stamp = (value: unknown): number | null =>
      typeof value === "number" && Number.isFinite(new Date(value).getTime())
        ? value
        : null;
    return [
      {
        workflowId: schedule["workflowId"],
        ...cadence,
        state,
        failuresInRow: schedule["failuresInRow"],
        nextAt: stamp(schedule["nextAt"]),
        stoppedAt: stamp(schedule["stoppedAt"]),
      },
    ];
  });
}

export function statusScheduleLines(value: unknown): readonly string[] {
  const schedules = shownSchedules(value);
  return "status" in schedules
    ? ["Schedules: unavailable"]
    : schedules.map((schedule) => scheduleStatusLine(schedule));
}

export function shownScheduled(value: unknown): {
  readonly scheduled?: { readonly slot: number };
} {
  const slot = record(value)?.["slot"];
  return typeof slot === "number" && Number.isSafeInteger(slot) && slot >= 0
    ? { scheduled: { slot } }
    : {};
}

export function scheduledText(value: unknown): string {
  const { scheduled } = shownScheduled(value);
  return scheduled === undefined ? "" : `scheduled ${String(scheduled.slot)}`;
}
