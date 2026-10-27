import { record } from "./protocol.ts";
import { tokenCount, usageOf, type WorkerUsage } from "./worker-usage.ts";

function grokUsage(value: unknown): WorkerUsage {
  const fields = record(value) ?? {};
  const input = tokenCount(fields["input_tokens"]);
  const creation = tokenCount(fields["cache_creation_input_tokens"]);
  const read = tokenCount(fields["cache_read_input_tokens"]);
  const output = tokenCount(fields["output_tokens"]);
  if (input === null || creation === null || read === null || output === null)
    return usageOf(null);
  if (input + creation + read + output === 0) return usageOf(null);
  return {
    input_tokens: tokenCount(input + creation),
    cache_read_input_tokens: read,
    output_tokens: output,
  };
}

function attributedModel(
  result: Readonly<Record<string, unknown>>,
): string | null {
  const entries = Object.entries(record(result["modelUsage"]) ?? {});
  const [entry] = entries;
  if (entries.length !== 1 || entry === undefined) return null;
  const [model, row] = entry;
  const counts = record(row) ?? {};
  const aggregate = record(result["usage"]) ?? {};
  const fields = [
    ["input_tokens", "inputTokens"],
    ["cache_creation_input_tokens", "cacheCreationInputTokens"],
    ["cache_read_input_tokens", "cacheReadInputTokens"],
    ["output_tokens", "outputTokens"],
  ] as const;
  return fields.every(
    ([total, key]) =>
      tokenCount(aggregate[total]) !== null && aggregate[total] === counts[key],
  )
    ? model
    : null;
}

export function grokResultFields(value: unknown): {
  readonly usage: WorkerUsage;
  readonly failed: boolean;
  readonly pricingModel: string | null;
  readonly costUsd: number | null;
  readonly model?: string;
} {
  const fields = record(value) ?? {};
  const usage = grokUsage(fields["usage"]);
  const model = attributedModel(fields);
  return {
    usage,
    failed: fields["subtype"] !== "success" || fields["is_error"] !== false,
    pricingModel: model,
    costUsd: null,
    ...(model === null ? {} : { model }),
  };
}

export function grokUsageWarnings(): {
  readonly write: (chunk: string) => void;
  readonly incomplete: () => boolean;
} {
  let tail = "";
  let incomplete = false;
  return {
    write: (chunk) => {
      const text = tail + chunk;
      incomplete ||=
        /streaming-messages-json: (usage is incomplete|no aggregate usage ledger at turn end)/.test(
          text,
        );
      tail = text.slice(-128);
    },
    incomplete: () => incomplete,
  };
}
