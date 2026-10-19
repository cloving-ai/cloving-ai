import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { priceOf, sumUsage, usageOf } from "../worker-usage.ts";
import {
  capacityRefusal,
  startTurn,
  type RunningTurn,
  type TurnEnd,
  type TurnStart,
} from "./claude-turn.ts";
import { readRecord, writeRecord } from "./operation-journal.ts";

export interface RetrySettings {
  readonly retryDelay?: (
    milliseconds: number,
    signal: AbortSignal,
  ) => Promise<void>;
}

interface RetryOptions extends RetrySettings {
  readonly metadata: Readonly<Record<string, unknown>>;
}

const waits = [60_000, 180_000];
const continuation =
  "An earlier attempt stopped because the model was at capacity; continue from the current state of the work tree.\n\n";

interface Attempts {
  readonly start: TurnStart;
  readonly options: RetryOptions;
  readonly stopping: AbortController;
  readonly grace: { milliseconds: number };
  readonly ends: TurnEnd[];
}

function written(
  folder: string,
  entry: { readonly name: string; readonly value: unknown },
): Promise<void> {
  return writeRecord(folder, { ...entry, permissions: "private" });
}

function total(values: readonly (number | null)[]): number | null {
  if (values.includes(null)) return null;
  return priceOf(values.reduce<number>((sum, value) => sum + (value ?? 0), 0));
}

function combined(ends: readonly TurnEnd[]): TurnEnd {
  const last = ends.at(-1) ?? { exitCode: null, result: undefined };
  if (ends.length < 2) return last;
  const result = last.result ?? ends.find((end) => end.result)?.result;
  if (result === undefined) return last;
  return {
    ...last,
    result: {
      ...result,
      ...(last.result === undefined ? { failed: true, text: "" } : {}),
      usage: sumUsage(ends.map((end) => end.result?.usage ?? usageOf(null))),
      costUsd: total(ends.map((end) => end.result?.costUsd ?? null)),
      turns: total(ends.map((end) => end.result?.turns ?? null)),
    },
  };
}

function controlled(attempts: Attempts, start: TurnStart): RunningTurn {
  const turn = startTurn(start);
  const stop = () => {
    turn.stop(attempts.grace.milliseconds);
  };
  attempts.stopping.signal.addEventListener("abort", stop, { once: true });
  return {
    ...turn,
    ended: turn.ended.finally(() => {
      attempts.stopping.signal.removeEventListener("abort", stop);
    }),
  };
}

async function launched(attempts: Attempts): Promise<RunningTurn | undefined> {
  const { start, options, ends } = attempts;
  const attempt = ends.length + 1;
  const folder =
    start.mode === "analysis" || attempt === 1
      ? start.folder
      : join(start.folder, `attempt-${String(attempt)}`);
  const entry = {
    ...options.metadata,
    attempt,
    startedAt: new Date().toISOString(),
  };
  await written(start.folder, {
    name: "started.json",
    value: { ...entry, phase: "starting", processId: null },
  });
  await mkdir(folder, { recursive: true, mode: 0o700 });
  if (attempts.stopping.signal.aborted) return undefined;
  const turn = controlled(attempts, {
    ...start,
    folder,
    ...(attempt === 1 ? {} : { activityFolder: start.folder }),
    prompt: attempt === 1 ? start.prompt : continuation + start.prompt,
  });
  try {
    const value = { ...entry, phase: "running", processId: turn.processId };
    await written(start.folder, { name: "started.json", value });
    await written(start.folder, {
      name: `attempt-${String(attempt)}.json`,
      value,
    });
    return turn;
  } catch (error) {
    turn.stop(0);
    await turn.ended;
    throw error;
  }
}

async function recordedEnd(
  attempts: Attempts,
  completion: { readonly processId: number | null; readonly end: TurnEnd },
): Promise<void> {
  const { start, ends, options } = attempts;
  const { processId, end } = completion;
  const attempt = ends.length;
  const name = `attempt-${String(attempt)}.json`;
  const started = await readRecord(start.folder, name);
  const startedAt: unknown = Reflect.get(Object(started), "startedAt");
  if (typeof startedAt !== "string")
    throw new Error("attempt-start-time-missing");
  await written(start.folder, {
    name,
    value: {
      ...options.metadata,
      attempt,
      processId,
      startedAt,
      endedAt: new Date().toISOString(),
      exitCode: end.exitCode,
      capacity: capacityRefusal(end.result),
      usage: end.result?.usage ?? usageOf(null),
      costUsd: end.result?.costUsd ?? null,
    },
  });
}

async function waited(attempts: Attempts, milliseconds: number): Promise<void> {
  const { start, options, stopping, ends } = attempts;
  await written(start.folder, {
    name: "started.json",
    value: {
      ...options.metadata,
      attempt: ends.length,
      phase: "waiting",
      processId: null,
      waitMilliseconds: milliseconds,
      waitingAt: new Date().toISOString(),
    },
  });
  const wait =
    options.retryDelay ??
    ((duration, signal) => delay(duration, undefined, { signal }));
  await wait(milliseconds, stopping.signal).catch((error: unknown) => {
    if (!stopping.signal.aborted) throw error;
  });
}

async function finished(
  attempts: Attempts,
  first: RunningTurn,
): Promise<TurnEnd> {
  const { ends } = attempts;
  let turn: RunningTurn | undefined = first;
  while (turn !== undefined) {
    const end = await turn.ended;
    ends.push(end);
    await recordedEnd(attempts, { processId: turn.processId, end });
    const milliseconds = waits[ends.length - 1];
    if (
      cancelled(attempts) ||
      !capacityRefusal(end.result) ||
      milliseconds === undefined
    )
      break;
    await waited(attempts, milliseconds);
    if (cancelled(attempts)) return { ...combined(ends), stopped: true };
    turn = await launched(attempts);
  }
  return {
    ...combined(ends),
    ...(cancelled(attempts) || turn === undefined ? { stopped: true } : {}),
  };
}

function cancelled(attempts: Attempts): boolean {
  return attempts.stopping.signal.aborted;
}

export async function startRetriedTurn(
  start: TurnStart,
  options: RetryOptions,
): Promise<RunningTurn> {
  const attempts: Attempts = {
    start,
    options,
    stopping: new AbortController(),
    ends: [],
    grace: { milliseconds: 2_000 },
  };
  const turn = await launched(attempts);
  if (turn === undefined) throw new Error("turn-start-stopped");
  return {
    processId: turn.processId,
    ended: finished(attempts, turn),
    stop: (graceMilliseconds) => {
      attempts.grace.milliseconds = graceMilliseconds;
      attempts.stopping.abort();
    },
  };
}
