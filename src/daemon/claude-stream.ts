import type { ReviewVerdict } from "../review-subject.ts";
import type { TicketStatus } from "../ticket-status.ts";
import { grokResultFields } from "../grok-result.ts";
import {
  priceOf,
  modelUsageOf,
  usageOf,
  type WorkerUsage,
  type WorkerAttemptUsage,
  type WorkerModelUsage,
  type RetryKind,
} from "../worker-usage.ts";

export type Worker = string;

export interface StreamResult {
  readonly reviewFeedback?: string;
  readonly reviewVerdict?: ReviewVerdict | null;
  readonly models?: readonly WorkerModelUsage[];
  readonly ticketStatusTooLarge?: true;
  readonly ticketStatus?: TicketStatus;
  readonly attempts?: readonly WorkerAttemptUsage[];
  readonly pricingModel?: string | null;
  readonly subtype?: string;
  readonly errorType?: string;
  readonly model: string | null;
  readonly text: string;
  readonly failed: boolean;
  readonly costUsd: number | null;
  readonly usage: WorkerUsage;
  readonly sessionId: string | null;
  readonly turns: number | null;
}

export function parsed(line: string): unknown {
  try {
    const value: unknown = JSON.parse(line);
    return value;
  } catch {
    return undefined;
  }
}

function numberOf(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

export function textOf(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function networkFailure(result: StreamResult | undefined): boolean {
  return (
    result?.failed === true &&
    result.text.startsWith("API Error: Can't reach the API server")
  );
}

export function capacityRefusal(result: StreamResult | undefined): boolean {
  if (networkFailure(result)) return false;
  return (
    result?.failed === true &&
    ["success", "error_during_execution"].includes(
      result.subtype ?? "error_during_execution",
    ) &&
    (result.text ===
      "Selected model is at capacity. Please try a different model." ||
      result.errorType === "overloaded")
  );
}

export function retryKind(result: StreamResult | undefined): RetryKind | null {
  if (networkFailure(result)) return "network";
  return capacityRefusal(result) ? "capacity" : null;
}

export function streamResult(
  line: string,
  worker?: Worker,
): StreamResult | undefined {
  if (!line.includes('"result"')) return undefined;
  const record: unknown = parsed(line);
  if (typeof record !== "object" || record === null) return undefined;
  const field = (name: string): unknown => Reflect.get(record, name);
  if (field("type") !== "result") return undefined;
  const models = modelUsageOf(field("models"));
  return {
    ...(models === undefined ? {} : { models }),
    ...(typeof field("subtype") === "string"
      ? { subtype: String(field("subtype")) }
      : {}),
    ...(typeof field("error") === "string"
      ? { errorType: String(field("error")) }
      : {}),
    text: textOf(field("result")) ?? "",
    failed: field("is_error") === true,
    costUsd: priceOf(field("total_cost_usd")),
    usage: usageOf(field("usage")),
    model: textOf(field("model")),
    sessionId: textOf(field("session_id")),
    turns: numberOf(field("num_turns")),
    ...(worker === "grok" ? grokResultFields(record) : {}),
  };
}
