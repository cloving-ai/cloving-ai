import { record, type Fields } from "../protocol.ts";

function line(value: unknown): string {
  const schedule = record(value) ?? {};
  const nextAt = schedule["nextAt"];
  const runId = schedule["activeRunId"];
  const activeRun = typeof runId === "string" ? runId : "none";
  const next =
    typeof nextAt === "number" ? new Date(nextAt).toISOString() : "none";
  return `  ${String(schedule["workflowId"])}  every ${String(schedule["everySeconds"])} seconds  ${String(schedule["state"])}  next ${next}  ${String(schedule["failuresInRow"])} failures in a row  slot ${String(schedule["lastSlot"])}  active run ${activeRun}`;
}

export function scheduleLines(result: Fields): readonly string[] {
  if (result["kind"] === "schedule") return [line(result["schedule"])];
  const schedules = result["schedules"];
  const lines = Array.isArray(schedules) ? schedules.map(line) : [];
  return ["Schedules:", ...(lines.length === 0 ? ["  none"] : lines)];
}

export interface ShownSchedule {
  readonly workflowId: string;
  readonly everySeconds: number;
  readonly state: "active" | "paused" | "stopped";
  readonly failuresInRow: number;
  readonly nextAt: number | null;
  readonly stoppedAt: number | null;
}

export function scheduleStatusLine(
  schedule: ShownSchedule,
  style: "status" | "watch" = "status",
): string {
  const time = (at: number): string =>
    style === "watch"
      ? new Date(at).toLocaleString()
      : new Date(at).toISOString();
  const next =
    schedule.state === "active" && schedule.nextAt !== null
      ? `, next run at ${time(schedule.nextAt)}`
      : "";
  const stopped =
    schedule.state === "stopped" && schedule.stoppedAt !== null
      ? `, stopped at ${time(schedule.stoppedAt)}`
      : "";
  return `Schedule ${schedule.workflowId}: every ${String(schedule.everySeconds)} s, ${schedule.state}${next}${stopped}, ${String(schedule.failuresInRow)} failures in a row`;
}

export type ShownSchedules =
  readonly ShownSchedule[] | { readonly status: "unavailable" };

export function shownSchedules(value: unknown): ShownSchedules {
  if (record(value)?.["status"] === "unavailable")
    return { status: "unavailable" };
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) => {
    const schedule = record(entry);
    if (
      typeof schedule?.["workflowId"] !== "string" ||
      typeof schedule["everySeconds"] !== "number" ||
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
        everySeconds: schedule["everySeconds"],
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
