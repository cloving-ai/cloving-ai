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
  type TurnEnd,
  type TurnStart,
} from "./claude-turn.ts";
import { nativeHarness } from "../harness-defaults.ts";
import { profileCommand } from "../turn-profile.ts";
import type { TurnResume } from "./claude-recovery.ts";

export interface RetrySettings {
  readonly tokenPrices?: TokenPrices;
  readonly fallbackModels?: readonly string[];
  readonly retryDelay?: (
    milliseconds: number,
    signal: AbortSignal,
  ) => Promise<void>;
}

export interface RetryOptions extends RetrySettings {
  readonly resume?: TurnResume;
  readonly stopping?: AbortController;
  readonly stopMilliseconds?: number;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface Attempts {
  failure?: string;
  readonly start: TurnStart;
  readonly turnStartCommit: string | null;
  readonly startedAt: string;
  readonly options: RetryOptions;
  readonly stopping: AbortController;
  readonly grace: { milliseconds: number };
  readonly ends: TurnEnd[];
}

export function total(values: readonly (number | null)[]): number | null {
  if (values.includes(null)) return null;
  return priceOf(values.reduce<number>((sum, value) => sum + (value ?? 0), 0));
}

export function combined(attempts: Attempts): TurnEnd {
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
      costUsd:
        (attempts.start.worker ?? "claude") === "claude"
          ? sessionCost(ends)
          : total(ends.map((end) => end.result?.costUsd ?? null)),
      turns: total(ends.map((end) => end.result?.turns ?? null)),
    },
  };
}

export function attemptCommand(attempts: Attempts, attempt: number) {
  const { start, options } = attempts;
  const original = start.command;
  const previous = attempts.ends[attempt - 2];
  const ordinal =
    attempt -
    attempts.ends
      .slice(0, attempt - 1)
      .filter((end) => end.resumedAfter !== undefined).length;
  const fallback =
    previous !== undefined && kindOf(attempts, previous) === "capacity"
      ? options.fallbackModels?.[ordinal - 3]
      : undefined;
  const selected =
    fallback === undefined ? original : replaceCommandModel(original, fallback);
  const budgetUsd = remainingBudget(attempts);
  const command =
    budgetUsd === undefined
      ? selected
      : profileCommand(selected, { maxBudgetUsd: budgetUsd });
  const model = start.output === "text" ? null : commandModel(command);
  return {
    command,
    ...(budgetUsd === undefined ? {} : { budgetUsd }),
    model,
    ...(fallback !== undefined && model === null
      ? { fallbackReason: "fallback-model-unavailable" }
      : {}),
  };
}

export function attemptUsage(
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
    ...(end.resumedAfter === undefined
      ? {}
      : { resumedAfter: end.resumedAfter }),
    retryKind: kindOf(attempts, end),
    model,
    ...(end.result?.models === undefined ? {} : { models: end.result.models }),
    usage,
    costUsd:
      (attempts.start.worker ?? "claude") === "claude"
        ? attemptCost(attempts.ends, attempt - 1)
        : result.costUsd,
    estimatedCostUsd: attemptEstimate(attempts, { end, model, usage }),
  };
}

export function sessionCost(ends: readonly TurnEnd[]): number | null {
  const sessions = new Map<string | number, number | null>();
  ends.forEach((end, index) => {
    sessions.set(end.result?.sessionId ?? index, end.result?.costUsd ?? null);
  });
  return total([...sessions.values()]);
}

export function attemptCost(
  ends: readonly TurnEnd[],
  index: number,
): number | null {
  const result = ends[index]?.result;
  if (result?.costUsd == null) return null;
  const earlier =
    result.sessionId === null
      ? undefined
      : ends
          .slice(0, index)
          .findLast((end) => end.result?.sessionId === result.sessionId);
  if (earlier === undefined) return result.costUsd;
  const cost = earlier.result?.costUsd;
  return cost == null
    ? null
    : priceOf(Number((result.costUsd - cost).toFixed(12)));
}

function remainingBudget(attempts: Attempts): number | undefined {
  if (
    (attempts.start.worker ?? "claude") !== "claude" ||
    attempts.start.output === "text"
  )
    return undefined;
  const budget = commandBudget(attempts.start.command);
  if (budget === undefined) return undefined;
  const spent = sessionCost(attempts.ends);
  return Math.max(0, Number((budget - (spent ?? 0)).toFixed(12)));
}

function commandBudget(original: readonly string[]): number | undefined {
  const separator = original.indexOf("--");
  const command = separator < 0 ? original : original.slice(0, separator);
  const index = command.findLastIndex(
    (part) =>
      part === "--max-budget-usd" || part.startsWith("--max-budget-usd="),
  );
  if (index < 0) return undefined;
  const argument = command[index] ?? "";
  const budget = Number(
    argument.includes("=") ? argument.split("=")[1] : command[index + 1],
  );
  if (!Number.isFinite(budget) || budget < 0) return undefined;
  return budget;
}

export function attemptEstimate(
  attempts: Attempts,
  result: {
    readonly end: TurnEnd;
    readonly model: string | null;
    readonly usage: ReturnType<typeof usageOf>;
  },
): number | null {
  const worker = attempts.start.worker ?? "claude";
  if (!nativeHarness(worker)) return null;
  const models = result.end.result?.models;
  const prices = attempts.options.tokenPrices ?? {};
  return estimatedCostUsd(
    result.usage,
    worker === "gemini" && models !== undefined
      ? { worker, models, prices }
      : {
          worker,
          price: priceForModel(
            prices,
            result.end.result?.pricingModel === undefined
              ? result.model
              : result.end.result.pricingModel,
          ),
        },
  );
}

export function kindOf(attempts: Attempts, end: TurnEnd) {
  const { worker, output } = attempts.start;
  if (output === "text" || !["claude", "codex"].includes(worker ?? "claude"))
    return null;
  if (worker !== "codex") return end.retryKind ?? retryKind(end.result);
  return capacityRefusal(end.result) ? "capacity" : null;
}
