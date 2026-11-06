import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  holdPeriodOf,
  type HoldPeriod,
  type QueueHold,
} from "../queue-room.ts";

const keptMilliseconds = 30 * 86_400_000;
const keptPeriods = 1000;

export interface HoldRecord {
  readonly periods: () => readonly HoldPeriod[];
  readonly note: (hold: QueueHold | undefined) => Promise<void>;
  readonly close: () => Promise<void>;
}

function invalid(): never {
  throw new Error("invalid-queue-holds");
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return invalid();
  }
}

async function savedPeriods(file: string): Promise<HoldPeriod[]> {
  const text = await readFile(file, "utf8").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return '{"periods":[]}';
    throw error;
  });
  const value: unknown = parsed(text);
  const listed: unknown =
    value !== null && typeof value === "object"
      ? Reflect.get(value, "periods")
      : undefined;
  if (!Array.isArray(listed)) invalid();
  return listed.map((entry: unknown) => {
    const period = holdPeriodOf(entry);
    if (period?.endedAt == null) invalid();
    return period;
  });
}

export async function holdRecord(
  directory: string,
  now: () => number = Date.now,
): Promise<HoldRecord> {
  const file = join(directory, "queue-holds.json");
  let closed = await savedPeriods(file);
  let open: HoldPeriod | undefined;
  const save = async (): Promise<void> => {
    const since = now() - keptMilliseconds;
    closed = closed
      .filter((period) => (period.endedAt ?? since) >= since)
      .slice(-keptPeriods);
    await writeFile(`${file}.tmp`, JSON.stringify({ periods: closed }) + "\n", {
      mode: 0o600,
    });
    await rename(`${file}.tmp`, file);
  };
  const ended = async (): Promise<void> => {
    if (open === undefined) return;
    closed = [...closed, { ...open, endedAt: now() }];
    open = undefined;
    await save();
  };
  return {
    periods: () => (open === undefined ? closed : [...closed, open]),
    note: async (hold) => {
      const reason =
        hold?.reason === "working-lanes" ? undefined : hold?.reason;
      if (open !== undefined && open.reason === reason) return;
      await ended();
      if (reason !== undefined)
        open = { reason, startedAt: now(), endedAt: null };
    },
    close: ended,
  };
}
