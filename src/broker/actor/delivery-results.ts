import type { JsonObject } from "solid-objects";
import { integer, optionalText, text } from "../../storage/domain-rows.ts";
import type { DeliveryResult } from "./turn-plan.ts";

export type Outcome = Omit<
  DeliveryResult,
  "runId" | "intent" | "leaseGeneration" | "purpose" | "attempts"
> & { readonly inputDigest: string };

export interface Present {
  readonly epoch: number;
  readonly recordedAt: string;
}

function stated(result: unknown, name: string): string | null {
  const value: unknown = Reflect.get(Object(result), name);
  return typeof value === "string" ? value : null;
}

const resultKinds = [
  "sent",
  "withheld",
  "blocked",
  "accepted",
  "refused",
  "completed",
  "failed",
  "stopped",
  "unknown",
  "absent",
] as const;

function resultKind(kind: string): (typeof resultKinds)[number] {
  const known = resultKinds.find((candidate) => candidate === kind);
  if (known === undefined) throw new Error(`invalid-delivery-result: ${kind}`);
  return known;
}

function callback(
  payload: JsonObject,
): Pick<Outcome, "effectId" | "operationId" | "inputDigest"> {
  const intent = payload["arguments"];
  return {
    effectId: text(payload, "effectId"),
    operationId: text(intent, "operationId"),
    inputDigest: text(intent, "inputDigest"),
  };
}

export function thrownOutcome(payload: JsonObject, present: Present): Outcome {
  return {
    ...callback(payload),
    outcome: "thrown",
    receipt: null,
    worker: null,
    result: null,
    reason: null,
    ...present,
  };
}

function readOutcome(payload: JsonObject): Outcome {
  const result: unknown = payload["result"];
  return {
    ...callback(payload),
    outcome: resultKind(text(result, "kind")),
    receipt: optionalText(result, "receipt"),
    worker: stated(result, "worker"),
    result: stated(result, "result"),
    reason: stated(result, "reason"),
    epoch: integer(result, "epoch"),
    recordedAt: text(result, "recordedAt"),
  };
}

export function completedOutcome(
  payload: JsonObject,
  present: Present,
): Outcome {
  try {
    return readOutcome(payload);
  } catch {
    return thrownOutcome(payload, present);
  }
}
