import {
  attemptsOf,
  priceOf,
  usageOf,
  type WorkerAttemptUsage,
} from "../worker-usage.ts";

export function priceText(value: unknown, estimate?: unknown): string {
  const price = priceOf(value);
  if (price === null && priceOf(estimate) !== null)
    return `≈ ${priceText(estimate)} (estimate)`;
  if (price === null) return "Price not known";
  return `${price.toLocaleString("en-US", {
    useGrouping: false,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} USD`;
}

export function usageText(value: unknown): string {
  const usage = usageOf(value);
  return [
    ["Input tokens", usage.input_tokens],
    ["Cache read tokens", usage.cache_read_input_tokens],
    ...(usage.cache_creation_input_tokens === undefined
      ? []
      : [["Cache write tokens", usage.cache_creation_input_tokens]]),
    ["Output tokens", usage.output_tokens],
  ]
    .map(
      ([label, count]) =>
        `${String(label)}: ${count === null ? "Token usage not known" : String(count)}`,
    )
    .join(" · ");
}

export function totalsSuffix(state: unknown): string {
  return ["completed", "failed", "cancelled"].includes(String(state))
    ? ""
    : " so far";
}

export function statusJson(result: Fields): Fields {
  const run = record(result["run"]);
  if (result["kind"] !== "run-status" || run === undefined) return result;
  const turns = run["workerTurns"];
  return {
    ...result,
    run: {
      ...run,
      costDisplay: priceText(run["claudeCostUsd"], run["estimatedCostUsd"]),
      ...(Array.isArray(turns)
        ? {
            workerTurns: turns.map((turn: unknown) => {
              const fields = record(turn);
              if (fields === undefined) return turn;
              return {
                ...fields,
                costDisplay: priceText(
                  fields["costUsd"],
                  fields["estimatedCostUsd"],
                ),
              };
            }),
          }
        : {}),
    },
  };
}

import { record, type Fields } from "../protocol.ts";

export function attemptText(attempt: WorkerAttemptUsage): string {
  const kind =
    attempt.retryKind === undefined
      ? ""
      : ` · retryKind: ${String(attempt.retryKind)}`;
  const resumed =
    attempt.resumedAfter === undefined
      ? ""
      : ` · resumedAfter: ${attempt.resumedAfter}`;
  return `Attempt ${String(attempt.attempt)} · ${attempt.model ?? "Model not known"}${kind}${resumed} · ${priceText(attempt.costUsd, attempt.estimatedCostUsd)}`;
}

export function attemptTexts(value: unknown): readonly string[] {
  return (attemptsOf(value) ?? []).map(attemptText);
}

export function queueSpendLines(value: unknown): readonly string[] {
  const spend = record(value);
  if (spend === undefined) return [];
  const spent = priceOf(spend["spentUsd"]);
  const limit = priceOf(spend["limitUsd"]);
  const unknown = Number(spend["unknownTurns"]);
  const working = Number(spend["turnsInWork"]);
  return [
    `Spend: ${priceText(spent).replace(/ USD$/, "")} of ${priceText(limit)} in the last 24 hours`,
    ...(unknown > 0
      ? [`${String(unknown)} turn${unknown === 1 ? "" : "s"} with unknown cost`]
      : []),
    ...(working > 0
      ? [`${String(working)} turn${working === 1 ? "" : "s"} in work`]
      : []),
    ...(spend["holding"] === true
      ? ["Queue holds new runs for spend limit"]
      : []),
    ...(spent !== null && limit !== null && spent > limit
      ? ["Spend is over the limit"]
      : []),
  ];
}
