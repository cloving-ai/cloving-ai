import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { record, type Fields } from "../protocol.ts";
import { isCommandId, isRecordKey } from "../authority/commands.ts";

export type PendingSlot =
  | { readonly kind: "run"; readonly input: Fields }
  | { readonly kind: "skip"; readonly runId: string };

export interface ScheduleProgress {
  readonly everySeconds: number;
  readonly nextAt: number;
  readonly lastSlot: number;
  readonly activeCommandId?: string;
  readonly pending?: PendingSlot;
}

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

function isProgress(value: unknown): value is ScheduleProgress {
  const fields = record(value);
  if (fields === undefined) return false;
  const { activeCommandId, pending } = fields;
  return (
    timing(fields) &&
    (activeCommandId === undefined || isCommandId(activeCommandId)) &&
    (pending === undefined || pendingSlot(pending))
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
    entries.set(workflowId, value);
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
