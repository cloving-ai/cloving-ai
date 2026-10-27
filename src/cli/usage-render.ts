import { priceOf, usageOf } from "../worker-usage.ts";

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
