import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  holdPeriodOf,
  type HoldPeriod,
  type QueueHold,
} from "../queue-room.ts";

const keptMilliseconds = 30 * 86_400_000;
const keptPeriods = 1000;
const seenMilliseconds = 60_000;

export interface HoldRecord {
  readonly periods: () => readonly HoldPeriod[];
  readonly cutAt: () => number | null;
  readonly note: (hold: QueueHold | undefined) => Promise<void>;
  readonly close: () => Promise<void>;
}

interface OpenHold {
  readonly reason: HoldPeriod["reason"];
  readonly startedAt: number;
  readonly seenAt: number;
}

interface SavedHolds {
  readonly closed: HoldPeriod[];
  readonly cutAt: number | null;
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

function closedPeriod(entry: unknown): HoldPeriod {
  const period = holdPeriodOf(entry);
  if (period?.endedAt == null) invalid();
  return period;
}

function recovered(value: unknown): readonly HoldPeriod[] {
  if (value === undefined || value === null) return [];
  if (typeof value !== "object") invalid();
  const reason: unknown = Reflect.get(value, "reason");
  const startedAt: unknown = Reflect.get(value, "startedAt");
  const endedAt: unknown = Reflect.get(value, "seenAt");
  return [closedPeriod({ reason, startedAt, endedAt })];
}

function cutOf(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0)
    return value;
  return invalid();
}

async function savedHolds(file: string): Promise<SavedHolds | undefined> {
  const text = await readFile(file, "utf8").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  });
  if (text === undefined) return undefined;
  const value: unknown = parsed(text);
  if (value === null || typeof value !== "object") invalid();
  const listed: unknown = Reflect.get(value, "periods");
  if (!Array.isArray(listed)) invalid();
  return {
    closed: [
      ...listed.map(closedPeriod),
      ...recovered(Reflect.get(value, "open")),
    ],
    cutAt: cutOf(Reflect.get(value, "cutAt")),
  };
}

function trimmed(saved: SavedHolds, since: number): SavedHolds {
  const ended = (period: HoldPeriod): number => period.endedAt ?? since;
  const recent = saved.closed.filter((period) => ended(period) >= since);
  const dropped = [
    ...saved.closed.filter((period) => ended(period) < since),
    ...recent.slice(0, -keptPeriods),
  ];
  return {
    closed: recent.slice(-keptPeriods),
    cutAt:
      dropped.length === 0
        ? saved.cutAt
        : Math.max(saved.cutAt ?? 0, ...dropped.map(ended)),
  };
}

export async function holdRecord(
  directory: string,
  now: () => number = Date.now,
): Promise<HoldRecord> {
  const file = join(directory, "queue-holds.json");
  const found = await savedHolds(file);
  let saved = found ?? { closed: [], cutAt: now() };
  let open: OpenHold | undefined;
  const save = async (): Promise<void> => {
    saved = trimmed(saved, now() - keptMilliseconds);
    const text = JSON.stringify({
      periods: saved.closed,
      open: open ?? null,
      cutAt: saved.cutAt,
    });
    await writeFile(`${file}.tmp`, text + "\n", { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  };
  if (found === undefined) await save();
  const finish = (): void => {
    if (open === undefined) return;
    const { reason, startedAt } = open;
    const closed = [...saved.closed, { reason, startedAt, endedAt: now() }];
    saved = { ...saved, closed };
    open = undefined;
  };
  const seen = async (): Promise<void> => {
    if (open === undefined || now() - open.seenAt < seenMilliseconds) return;
    open = { ...open, seenAt: now() };
    await save();
  };
  return {
    periods: () =>
      open === undefined
        ? saved.closed
        : [
            ...saved.closed,
            { reason: open.reason, startedAt: open.startedAt, endedAt: null },
          ],
    cutAt: () => saved.cutAt,
    note: async (hold) => {
      const reason =
        hold?.reason === "working-lanes" ? undefined : hold?.reason;
      if (open?.reason === reason) return seen();
      finish();
      if (reason !== undefined)
        open = { reason, startedAt: now(), seenAt: now() };
      await save();
    },
    close: async () => {
      if (open === undefined) return;
      finish();
      await save();
    },
  };
}
