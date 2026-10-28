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
  retryKind,
  startTurn,
  type RunningTurn,
  type TurnEnd,
  type TurnStart,
} from "./claude-turn.ts";
import { turnHead, retryEvidence, indexFailure } from "./retry-worktree.ts";
import { readRecord, writeRecord } from "./operation-journal.ts";
import { nativeHarness } from "../harness-defaults.ts";

export interface RetrySettings {
  readonly tokenPrices?: TokenPrices;
  readonly fallbackModels?: readonly string[];
  readonly retryDelay?: (
    milliseconds: number,
    signal: AbortSignal,
  ) => Promise<void>;
}

interface RetryOptions extends RetrySettings {
  readonly stopping?: AbortController;
  readonly stopMilliseconds?: number;
  readonly metadata: Readonly<Record<string, unknown>>;
}

const waits = { capacity: [60_000, 180_000], network: [600_000, 2_400_000] };
const networkContinuation =
  "An earlier attempt stopped because the network was not available. Continue from the current state of the work tree. Check each earlier commit, push, review comment and message. Do not repeat a write that is done. Stop and report a write whose result is not known.";
const continuation =
  "An earlier attempt stopped because the model was at capacity; continue from the current state of the work tree.\n\n";

interface Attempts {
  readonly start: TurnStart;
  readonly turnStartCommit: string | null;
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
  const previous = attempts.ends[attempt - 2];
  const fallback =
    previous !== undefined && kindOf(attempts, previous) === "capacity"
      ? options.fallbackModels?.[attempt - 3]
      : undefined;
  const command =
    fallback === undefined ? original : replaceCommandModel(original, fallback);
  const model = start.output === "text" ? null : commandModel(command);
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
  const worker = attempts.start.worker ?? "claude";
  return {
    attempt,
    retryKind: kindOf(attempts, end),
    model,
    usage,
    costUsd: result.costUsd,
    estimatedCostUsd: nativeHarness(worker)
      ? estimatedCostUsd(usage, {
          worker,
          price: priceForModel(
            attempts.options.tokenPrices ?? {},
            result.pricingModel === undefined ? model : result.pricingModel,
          ),
        })
      : null,
  };
}

function retriesCapacity(worker: string | undefined): boolean {
  return ["claude", "codex"].includes(worker ?? "claude");
}

function kindOf(attempts: Attempts, end: TurnEnd) {
  const { worker, output } = attempts.start;
  if (output === "text" || !retriesCapacity(worker)) return null;
  if (worker !== "codex") return retryKind(end.result);
  return capacityRefusal(end.result) ? "capacity" : null;
}

async function promptOf(attempts: Attempts): Promise<string> {
  const { start, ends, stopping, turnStartCommit } = attempts;
  if (ends.length === 0) return start.prompt;
  if (!ends.some((end) => kindOf(attempts, end) === "network"))
    return continuation + start.prompt;
  const evidence = await retryEvidence(
    { directory: start.directory, signal: stopping.signal },
    turnStartCommit,
  );
  return `${networkContinuation}\n\nCommits since the start of this turn:\n${evidence}\n\n${start.prompt}`;
}

async function launched(
  attempts: Attempts,
  prompt = attempts.start.prompt,
): Promise<RunningTurn | undefined> {
  const { start, options, ends } = attempts;
  const attempt = ends.length + 1;
  const selected = attemptCommand(attempts, attempt);
  const folder =
    attempt === 1
      ? start.folder
      : join(start.folder, `attempt-${String(attempt)}`);
  const entry = {
    ...options.metadata,
    turnStartCommit: attempts.turnStartCommit,
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
    prompt,
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
      turnStartCommit: attempts.turnStartCommit,
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
      turnStartCommit: attempts.turnStartCommit,
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

async function preparedRetry(attempts: Attempts): Promise<string | TurnEnd> {
  const prompt = await promptOf(attempts);
  const failure = await indexFailure({
    directory: attempts.start.directory,
    signal: attempts.stopping.signal,
  });
  if (cancelled(attempts)) return { ...combined(attempts), stopped: true };
  if (failure !== null) {
    await written(attempts.start.folder, {
      name: "retry-failure.json",
      value: failure,
    });
    return {
      ...combined(attempts),
      reason: failure.reason,
      detail: `${failure.fix}${failure.lockPath === undefined ? "" : ` Lock: ${failure.lockPath}`}`,
    };
  }
  return prompt;
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
    const kind = kindOf(attempts, end);
    const milliseconds =
      kind === null ? undefined : waits[kind][ends.length - 1];
    if (cancelled(attempts) || milliseconds === undefined) break;
    await waited(attempts, milliseconds);
    if (cancelled(attempts)) return { ...combined(attempts), stopped: true };
    const prepared = await preparedRetry(attempts);
    if (typeof prepared !== "string") return prepared;
    turn = await launched(attempts, prepared);
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
  const stopping = options.stopping ?? new AbortController();
  const turnStartCommit = await turnHead({
    directory: start.directory,
    signal: stopping.signal,
  });
  const attempts: Attempts = {
    turnStartCommit,
    start,
    startedAt: new Date().toISOString(),
    options,
    stopping,
    ends: [],
    grace: { milliseconds: options.stopMilliseconds ?? 2_000 },
  };
  const turn = await launched(attempts);
  if (turn === undefined)
    return {
      processId: null,
      ended: Promise.resolve({
        exitCode: null,
        result: undefined,
        stopped: true,
      }),
      stop: () => {
        stopping.abort();
      },
    };
  return {
    processId: turn.processId,
    ended: finished(attempts, turn),
    stop: (graceMilliseconds) => {
      attempts.grace.milliseconds = graceMilliseconds;
      attempts.stopping.abort();
    },
  };
}
