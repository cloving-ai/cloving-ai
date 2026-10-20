import { priceOf, usageOf, type WorkerUsage } from "./worker-usage.ts";
import { record } from "./protocol.ts";

export interface TokenPrice {
  readonly input: number;
  readonly cachedInput: number;
  readonly output: number;
}

export type TokenPrices = Readonly<Record<string, TokenPrice>>;

export const builtInPriceTable: {
  readonly date: string;
  readonly source: string;
  readonly prices: TokenPrices;
} = {
  date: "2026-10-18",
  source: "https://openai.com/api/pricing/",
  prices: {
    "gpt-6.1-sol": { input: 2, cachedInput: 0.1, output: 10 },
    "gpt-6-astra": { input: 10, cachedInput: 1, output: 50 },
  },
};

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
  if (value === undefined) return { ...builtInPriceTable.prices };
  try {
    const fields = record(JSON.parse(value));
    if (fields === undefined) throw new Error("Invalid CLOVING_TOKEN_PRICES");
    return {
      ...builtInPriceTable.prices,
      ...Object.fromEntries(
        Object.entries(fields).map(([model, price]) => [
          model,
          tokenPrice(price),
        ]),
      ),
    };
  } catch {
    throw new Error("Invalid CLOVING_TOKEN_PRICES");
  }
}

export function parseFallbackModels(
  value: string | undefined,
): readonly string[] {
  if (value === undefined) return [];
  try {
    const models: unknown = JSON.parse(value);
    if (
      Array.isArray(models) &&
      models.length <= 3 &&
      models.every(
        (model: unknown) =>
          typeof model === "string" && model.trim().length > 0,
      )
    )
      return models.map(String);
  } catch {
    throw new Error("The daemon did not start: invalid-fallback-models");
  }
  throw new Error("The daemon did not start: invalid-fallback-models");
}

export function priceForModel(
  prices: TokenPrices,
  model: string | null,
): TokenPrice | undefined {
  return model !== null && Object.hasOwn(prices, model)
    ? prices[model]
    : undefined;
}

function modelIndex(command: readonly string[]): number | undefined {
  let selected: number | undefined;
  const separator = command.indexOf("--", 1);
  const end = separator === -1 ? command.length : separator;
  for (let index = 1; index < end; index += 1) {
    const argument = command[index] ?? "";
    if (argument.startsWith("--model="))
      selected = argument.slice(8) ? index : undefined;
    if (["--model", "-m"].includes(argument)) {
      const next = command[index + 1];
      selected = next && !next.startsWith("-") ? index + 1 : undefined;
      index += 1;
    }
  }
  return selected;
}

export function commandModel(command: readonly string[]): string | null {
  const index = modelIndex(command);
  if (index === undefined) return null;
  const argument = command[index] ?? "";
  return argument.startsWith("--model=") ? argument.slice(8) : argument;
}

export function replaceCommandModel(
  command: readonly string[],
  model: string,
): readonly string[] {
  const index = modelIndex(command);
  if (index === undefined) return command;
  return command.map((argument, position) => {
    if (position !== index) return argument;
    return argument.startsWith("--model=") ? `--model=${model}` : model;
  });
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
