export interface WorkerUsage {
  readonly cache_creation_input_tokens?: number | null;
  readonly input_tokens: number | null;
  readonly cache_read_input_tokens: number | null;
  readonly output_tokens: number | null;
}

export interface WorkerTurnUsage {
  readonly model?: string;
  readonly summary?: string;
  readonly harness?: string;
  readonly attempts?: readonly WorkerAttemptUsage[];
  readonly estimatedCostUsd: number | null;
  readonly operationId: string;
  readonly usage: WorkerUsage;
  readonly costUsd: number | null;
}

export interface WorkerAttemptUsage {
  readonly models?: readonly WorkerModelUsage[];
  readonly attempt: number;
  readonly model: string | null;
  readonly usage: WorkerUsage;
  readonly costUsd: number | null;
  readonly estimatedCostUsd: number | null;
}

export interface WorkerModelUsage {
  readonly model: string;
  readonly usage: WorkerUsage;
}

export function modelUsageOf(
  value: unknown,
): readonly WorkerModelUsage[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) return [];
    const model: unknown = Reflect.get(entry, "model");
    if (typeof model !== "string") return [];
    return [{ model, usage: usageOf(Reflect.get(entry, "usage")) }];
  });
}

export interface WorkerTotals {
  readonly estimatedCostUsd: number | null;
  readonly workerTurns: readonly WorkerTurnUsage[];
  readonly usage: WorkerUsage;
  readonly claudeCostUsd: number | null;
}

export function priceOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

export function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

export function usageOf(value: unknown): WorkerUsage {
  const fields = typeof value === "object" && value !== null ? value : {};
  return {
    ...(Object.hasOwn(fields, "cache_creation_input_tokens")
      ? {
          cache_creation_input_tokens: tokenCount(
            Reflect.get(fields, "cache_creation_input_tokens"),
          ),
        }
      : {}),
    input_tokens: tokenCount(Reflect.get(fields, "input_tokens")),
    cache_read_input_tokens: tokenCount(
      Reflect.get(fields, "cache_read_input_tokens"),
    ),
    output_tokens: tokenCount(Reflect.get(fields, "output_tokens")),
  };
}

function total(values: readonly (number | null)[]): number | null {
  if (values.length === 0 || values.includes(null)) return null;
  return tokenCount(
    values.reduce<number>((sum, value) => sum + (value ?? 0), 0),
  );
}

export function sumUsage(values: readonly WorkerUsage[]): WorkerUsage {
  return {
    ...(values.some((value) =>
      Object.hasOwn(value, "cache_creation_input_tokens"),
    )
      ? {
          cache_creation_input_tokens: total(
            values.map((value) => value.cache_creation_input_tokens ?? null),
          ),
        }
      : {}),
    input_tokens: total(values.map((value) => value.input_tokens)),
    cache_read_input_tokens: total(
      values.map((value) => value.cache_read_input_tokens),
    ),
    output_tokens: total(values.map((value) => value.output_tokens)),
  };
}

export function sumPrices(values: readonly (number | null)[]): number | null {
  const prices = values.map(priceOf);
  if (prices.length === 0 || prices.includes(null)) return null;
  return priceOf(prices.reduce<number>((sum, price) => sum + (price ?? 0), 0));
}

export function workerTotals(
  workerTurns: readonly WorkerTurnUsage[],
): WorkerTotals {
  return {
    workerTurns,
    usage: sumUsage(workerTurns.map((turn) => turn.usage)),
    claudeCostUsd: sumPrices(workerTurns.map((turn) => turn.costUsd)),
    estimatedCostUsd: sumPrices(
      workerTurns.map((turn) => turn.estimatedCostUsd),
    ),
  };
}
