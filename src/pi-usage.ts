import { record } from "./protocol.ts";
import {
  priceOf,
  sumUsage,
  sumPrices,
  tokenCount,
  type WorkerUsage,
} from "./worker-usage.ts";

export interface PiResponseUsage {
  readonly provider: string | null;
  readonly model: string | null;
  readonly responseId: string | null;
  readonly usage: WorkerUsage;
  readonly reportedEstimateUsd: number | null;
  readonly reportedBilledCostUsd: number | null;
  readonly costSource: "pi-reported-estimate" | "pi-provider-billed";
}

export interface PiAccounting {
  readonly scope: "primary-model";
  readonly responses: readonly PiResponseUsage[];
  readonly auxiliaryWork: boolean;
  readonly nestedUsage: WorkerUsage | null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

export function piUsage(value: unknown): WorkerUsage {
  const fields = record(value) ?? {};
  return {
    input_tokens: tokenCount(fields["input"]),
    cache_read_input_tokens: tokenCount(fields["cacheRead"]),
    cache_creation_input_tokens: tokenCount(fields["cacheWrite"]),
    output_tokens: tokenCount(fields["output"]),
  };
}

function reportedEstimate(value: unknown): number | null {
  const fields = record(value) ?? {};
  const cost = record(fields["cost"]) ?? {};
  const counts = piUsage(value);
  if (Object.values(counts).some((count) => count === null)) return null;
  const components = ["input", "output", "cacheRead", "cacheWrite"].map(
    (name) => priceOf(cost[name]),
  );
  const total = priceOf(cost["total"]);
  if (components.includes(null) || total === null) return null;
  const sum = components.reduce<number>((sum, price) => sum + (price ?? 0), 0);
  return Math.abs(sum - total) <= 1e-9 ? total : null;
}

export function piResponse(
  message: Readonly<Record<string, unknown>>,
): PiResponseUsage {
  return {
    provider: text(message["provider"]),
    model: text(message["responseModel"]) ?? text(message["model"]),
    responseId: text(message["responseId"]),
    usage: piUsage(message["usage"]),
    ...reportedCost(message["usage"]),
  };
}

export function piPricingModel(accounting: PiAccounting): string | null {
  if (accounting.auxiliaryWork) return null;
  const models = accounting.responses.map((response) =>
    response.provider === null || response.model === null
      ? null
      : `${response.provider}/${response.model}`,
  );
  return models.length > 0 && new Set(models).size === 1
    ? (models[0] ?? null)
    : null;
}

export function piTotalUsage(accounting: PiAccounting): WorkerUsage {
  return sumUsage(accounting.responses.map((response) => response.usage));
}

export function piAccountingOf(value: unknown): PiAccounting | undefined {
  const fields = record(value);
  const responses = fields?.["responses"];
  if (fields?.["scope"] !== "primary-model" || !Array.isArray(responses))
    return undefined;
  return {
    scope: "primary-model",
    auxiliaryWork: fields["auxiliaryWork"] !== false,
    nestedUsage:
      fields["nestedUsage"] === null
        ? null
        : normalizedUsage(fields["nestedUsage"]),
    responses: responses.map((value: unknown) => {
      const response = record(value) ?? {};
      return {
        provider: text(response["provider"]),
        model: text(response["model"]),
        responseId: text(response["responseId"]),
        usage: normalizedUsage(response["usage"]),
        reportedEstimateUsd: priceOf(response["reportedEstimateUsd"]),
        reportedBilledCostUsd: priceOf(response["reportedBilledCostUsd"]),
        costSource:
          response["costSource"] === "pi-provider-billed"
            ? "pi-provider-billed"
            : "pi-reported-estimate",
      };
    }),
  };
}

function normalizedUsage(value: unknown): WorkerUsage {
  const fields = record(value) ?? {};
  return {
    input_tokens: tokenCount(fields["input_tokens"]),
    cache_read_input_tokens: tokenCount(fields["cache_read_input_tokens"]),
    cache_creation_input_tokens: tokenCount(
      fields["cache_creation_input_tokens"],
    ),
    output_tokens: tokenCount(fields["output_tokens"]),
  };
}

function reportedCost(
  value: unknown,
): Pick<
  PiResponseUsage,
  "reportedEstimateUsd" | "reportedBilledCostUsd" | "costSource"
> {
  const cost = record(record(value)?.["cost"]);
  if (cost?.["totalFromProvider"] === true)
    return {
      costSource: "pi-provider-billed",
      reportedEstimateUsd: null,
      reportedBilledCostUsd: Object.values(piUsage(value)).includes(null)
        ? null
        : priceOf(cost["total"]),
    };
  return {
    costSource: "pi-reported-estimate",
    reportedEstimateUsd: reportedEstimate(value),
    reportedBilledCostUsd: null,
  };
}

export function piBilledCost(accounting: PiAccounting): number | null {
  return accounting.auxiliaryWork
    ? null
    : sumPrices(
        accounting.responses.map((response) => response.reportedBilledCostUsd),
      );
}
