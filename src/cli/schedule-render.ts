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
