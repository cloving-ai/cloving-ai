import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
  priceOf,
  sumUsage,
  usageOf,
  type WorkerAttemptUsage,
} from "../worker-usage.ts";
import {
  commandModel,
  replaceCommandModel,
  estimatedCostUsd,
  priceForModel,
  type TokenPrices,
} from "../token-prices.ts";
import {
  capacityRefusal,
  startTurn,
  type RunningTurn,
  type TurnEnd,
  type TurnStart,
} from "./claude-turn.ts";
import { readRecord, writeRecord } from "./operation-journal.ts";

export interface RetrySettings {
  readonly tokenPrices?: TokenPrices;
  readonly fallbackModels?: readonly string[];
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
  readonly startedAt: string;
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

function combined(attempts: Attempts): TurnEnd {
  const { ends } = attempts;
  const last = ends.at(-1) ?? { exitCode: null, result: undefined };
  const result = last.result ?? ends.find((end) => end.result)?.result;
  if (result === undefined) return last;
  return {
    ...last,
    result: {
      ...result,
      attempts: ends.map((end, index) =>
        attemptUsage(attempts, { end, attempt: index + 1 }),
      ),
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

function attemptCommand(attempts: Attempts, attempt: number) {
  const { start, options } = attempts;
  const original = start.command;
  const fallback = options.fallbackModels?.[attempt - 3];
  const command =
    fallback === undefined ? original : replaceCommandModel(original, fallback);
  const model = commandModel(command);
  return {
    command,
    model,
    ...(fallback !== undefined && model === null
      ? { fallbackReason: "fallback-model-unavailable" }
      : {}),
  };
}

function attemptUsage(
  attempts: Attempts,
  completion: { readonly end: TurnEnd; readonly attempt: number },
): WorkerAttemptUsage {
  const { end, attempt } = completion;
  const result = end.result ?? {
    model: null,
    usage: usageOf(null),
    costUsd: null,
    pricingModel: undefined,
  };
  const model = result.model ?? attemptCommand(attempts, attempt).model;
  const usage = result.usage;
  return {
    attempt,
    model,
    usage,
    costUsd: result.costUsd,
    estimatedCostUsd: estimatedCostUsd(usage, {
      worker: attempts.start.worker ?? "claude",
      price: priceForModel(
        attempts.options.tokenPrices ?? {},
        result.pricingModel === undefined ? model : result.pricingModel,
      ),
    }),
  };
}

async function launched(attempts: Attempts): Promise<RunningTurn | undefined> {
  const { start, options, ends } = attempts;
  const attempt = ends.length + 1;
  const selected = attemptCommand(attempts, attempt);
  const folder =
    attempt === 1
      ? start.folder
      : join(start.folder, `attempt-${String(attempt)}`);
  const entry = {
    ...options.metadata,
    model: selected.model,
    ...(selected.fallbackReason === undefined
      ? {}
      : { fallbackReason: selected.fallbackReason }),
    attempt,
    startedAt: attempt === 1 ? attempts.startedAt : new Date().toISOString(),
  };
  await written(start.folder, {
    name: "started.json",
    value: {
      ...entry,
      startedAt: attempts.startedAt,
      phase: "starting",
      processId: null,
    },
  });
  await mkdir(folder, { recursive: true, mode: 0o700 });
  if (attempts.stopping.signal.aborted) return undefined;
  const turn = controlled(attempts, {
    ...start,
    command: selected.command,
    folder,
    ...(attempt === 1 ? {} : { activityFolder: start.folder }),
    prompt: attempt === 1 ? start.prompt : continuation + start.prompt,
  });
  try {
    const value = { ...entry, phase: "running", processId: turn.processId };
    await written(start.folder, {
      name: "started.json",
      value: { ...value, startedAt: attempts.startedAt },
    });
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
  const selected = attemptCommand(attempts, attempt);
  const name = `attempt-${String(attempt)}.json`;
  const started = await readRecord(start.folder, name);
  const startedAt: unknown = Reflect.get(Object(started), "startedAt");
  if (typeof startedAt !== "string")
    throw new Error("attempt-start-time-missing");
  await written(start.folder, {
    name,
    value: {
      ...options.metadata,
      ...attemptUsage(attempts, { end, attempt }),
      ...(selected.fallbackReason === undefined
        ? {}
        : { fallbackReason: selected.fallbackReason }),
      attempt,
      processId,
      startedAt,
      endedAt: new Date().toISOString(),
      exitCode: end.exitCode,
      capacity: capacityRefusal(end.result),
    },
  });
}

async function waited(attempts: Attempts, milliseconds: number): Promise<void> {
  const { start, options, stopping, ends } = attempts;
  await written(start.folder, {
    name: "started.json",
    value: {
      ...options.metadata,
      startedAt: attempts.startedAt,
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
      attempts.start.worker === "opencode" ||
      attempts.start.worker === "grok" ||
      !capacityRefusal(end.result) ||
      milliseconds === undefined
    )
      break;
    await waited(attempts, milliseconds);
    if (cancelled(attempts)) return { ...combined(attempts), stopped: true };
    turn = await launched(attempts);
  }
  return {
    ...combined(attempts),
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
    startedAt: new Date().toISOString(),
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
