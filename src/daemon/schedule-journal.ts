import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { record, type Fields } from "../protocol.ts";
import { isCommandId, isRecordKey } from "../authority/commands.ts";
import type { PendingSlot, ScheduleProgress } from "../schedule-progress.ts";
export type { PendingSlot, ScheduleProgress } from "../schedule-progress.ts";

type ControlFields = "state" | "failuresInRow" | "failedRunIds";
type StoredProgress = Omit<ScheduleProgress, ControlFields> &
  Partial<Pick<ScheduleProgress, ControlFields>>;

function pendingSlot(value: unknown): value is PendingSlot {
  const fields = record(value);
  if (fields?.["kind"] === "run") return record(fields["input"]) !== undefined;
  return fields?.["kind"] === "skip" && isRecordKey(fields["runId"]);
}

function whole(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function timing(fields: Fields): boolean {
  const { everySeconds, nextAt, lastSlot } = fields;
  return (
    whole(everySeconds) &&
    everySeconds >= 60 &&
    everySeconds <= 86400 &&
    whole(nextAt) &&
    whole(lastSlot)
  );
}

function isProgress(value: unknown): value is StoredProgress {
  const fields = record(value);
  if (fields === undefined) return false;
  const { activeCommandId } = fields;
  return (
    timing(fields) &&
    control(fields) &&
    history(fields) &&
    pendingProgress(fields) &&
    (activeCommandId === undefined || isCommandId(activeCommandId))
  );
}

function pendingProgress(fields: Fields): boolean {
  const { pending, state } = fields;
  if (pending === undefined) return true;
  return (state === undefined || state === "active") && pendingSlot(pending);
}

function stopped(fields: Fields): boolean {
  const { state, stoppedAt, stoppedSlot } = fields;
  if (stoppedAt === undefined && stoppedSlot === undefined)
    return state !== "stopped";
  return (
    whole(stoppedAt) &&
    whole(stoppedSlot) &&
    stoppedSlot <= Number(fields["lastSlot"])
  );
}

function failures(fields: Fields): boolean {
  const { failuresInRow, failedRunIds } = fields;
  return (
    whole(failuresInRow) &&
    failuresInRow <= 3 &&
    Array.isArray(failedRunIds) &&
    failedRunIds.length === failuresInRow &&
    failedRunIds.every(isRecordKey) &&
    new Set(failedRunIds).size === failuresInRow
  );
}

function history(fields: Fields): boolean {
  const stops = fields["stops"];
  if (stops === undefined) return true;
  if (!Array.isArray(stops)) return false;
  let previousSlot = -1;
  for (const item of stops) {
    const stop = record(item);
    if (stop === undefined) return false;
    const slot = stop["stoppedSlot"];
    if (!whole(slot) || !whole(stop["stoppedAt"])) return false;
    if (slot <= previousSlot || slot > Number(fields["lastSlot"])) return false;
    if (!failures({ ...stop, failuresInRow: 3 })) return false;
    previousSlot = slot;
  }
  return true;
}

function control(fields: Fields): boolean {
  const { state, failuresInRow, failedRunIds } = fields;
  if (
    state === undefined &&
    failuresInRow === undefined &&
    failedRunIds === undefined
  )
    return (
      fields["stoppedAt"] === undefined && fields["stoppedSlot"] === undefined
    );
  return (
    ["active", "paused", "stopped"].includes(String(state)) &&
    failures(fields) &&
    stopped(fields) &&
    (state !== "stopped" || failuresInRow === 3)
  );
}

export async function scheduleJournal(directory: string): Promise<{
  readonly entries: Map<string, ScheduleProgress>;
  readonly save: () => Promise<void>;
}> {
  const file = join(directory, "schedules.json");
  const text = await readFile(file, "utf8").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return "{}";
    throw error;
  });
  const parsed = record(JSON.parse(text));
  if (parsed === undefined) throw new Error("invalid-schedule-state");
  const entries = new Map<string, ScheduleProgress>();
  for (const [workflowId, value] of Object.entries(parsed)) {
    if (!isProgress(value)) throw new Error("invalid-schedule-state");
    entries.set(workflowId, {
      ...value,
      state: value.state ?? "active",
      failuresInRow: value.failuresInRow ?? 0,
      failedRunIds: value.failedRunIds ?? [],
    });
  }
  return {
    entries,
    save: async () => {
      await writeFile(
        `${file}.tmp`,
        JSON.stringify(Object.fromEntries(entries)) + "\n",
        {
          mode: 0o600,
          flush: true,
        },
      );
      await rename(`${file}.tmp`, file);
    },
  };
}
