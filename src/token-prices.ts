import { priceOf, usageOf, type WorkerUsage } from "./worker-usage.ts";
import { record } from "./protocol.ts";

export interface TokenPrice {
  readonly input: number;
  readonly cachedInput: number;
  readonly output: number;
}

export type TokenPrices = Readonly<Record<string, TokenPrice>>;

function tokenPrice(value: unknown): TokenPrice {
  const fields = record(value);
  const input = priceOf(fields?.["input"]);
  const cachedInput = priceOf(fields?.["cachedInput"]);
  const output = priceOf(fields?.["output"]);
  if (input === null || cachedInput === null || output === null)
    throw new Error("Invalid CLOVING_TOKEN_PRICES");
  return { input, cachedInput, output };
}

export function parseTokenPrices(value: string | undefined): TokenPrices {
  if (value === undefined) return {};
  try {
    const fields = record(JSON.parse(value));
    if (fields === undefined) throw new Error("Invalid CLOVING_TOKEN_PRICES");
    return Object.fromEntries(
      Object.entries(fields).map(([model, price]) => [
        model,
        tokenPrice(price),
      ]),
    );
  } catch {
    throw new Error("Invalid CLOVING_TOKEN_PRICES");
  }
}

export function priceForModel(
  prices: TokenPrices,
  model: string | null,
): TokenPrice | undefined {
  return model !== null && Object.hasOwn(prices, model)
    ? prices[model]
    : undefined;
}

export function commandModel(command: readonly string[]): string | null {
  let model: string | null = null;
  for (let index = 1; index < command.length; index += 1) {
    const argument = command[index] ?? "";
    if (argument === "--") break;
    if (argument.startsWith("--model=")) model = argument.slice(8) || null;
    if (argument === "--model" || argument === "-m") {
      const next = command[index + 1];
      model = next && !next.startsWith("-") ? next : null;
      index += 1;
    }
  }
  return model;
}

export function estimatedCostUsd(
  usage: WorkerUsage,
  pricing: {
    readonly worker: "claude" | "codex";
    readonly price: TokenPrice | undefined;
  },
): number | null {
  const { worker, price } = pricing;
  const counts = usageOf(usage);
  const cached = counts.cache_read_input_tokens;
  const output = counts.output_tokens;
  if (
    price === undefined ||
    counts.input_tokens === null ||
    cached === null ||
    output === null
  )
    return null;
  const input = counts.input_tokens - (worker === "codex" ? cached : 0);
  if (input < 0) return null;
  return priceOf(
    (input / 1_000_000) * price.input +
      (cached / 1_000_000) * price.cachedInput +
      (output / 1_000_000) * price.output,
  );
}
