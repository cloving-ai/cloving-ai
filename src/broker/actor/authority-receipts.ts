import type { JsonObject } from "solid-objects";
import type { EffectIntent } from "../../authority/reducer.ts";
import { integer, text } from "../../storage/domain-rows.ts";
import { intentKind } from "../authority-restore.ts";

export type StoreReceipt =
  | {
      readonly kind: "accepted" | "duplicate";
      readonly sequence: number;
      readonly intents: readonly EffectIntent[];
      readonly disposition?: string;
    }
  | {
      readonly kind: "rejected";
      readonly reason: string;
      readonly detail?: string;
    }
  | {
      readonly kind: "failed";
      readonly reason:
        "storage-failure" | "storage-unavailable" | "authority-unavailable";
      readonly detail: string;
    };

export const unserializable: StoreReceipt = {
  kind: "rejected",
  reason: "invalid-command",
  detail: "unserializable-command",
};

export const invalidCommand: StoreReceipt = {
  kind: "rejected",
  reason: "invalid-command",
};

export const maximumRequestBytes = 900_000;

export const tooLarge: StoreReceipt = {
  kind: "rejected",
  reason: "request-too-large",
  detail: `A request has at most ${String(maximumRequestBytes)} bytes.`,
};

export function oversized(request: JsonObject): boolean {
  return Buffer.byteLength(JSON.stringify(request)) > maximumRequestBytes;
}

export function failed(
  error: unknown,
): Extract<StoreReceipt, { kind: "failed" }> {
  const name = String(Reflect.get(Object(error), "name"));
  if (name === "MessageFailed")
    return {
      kind: "failed",
      reason: "storage-failure",
      detail: String(
        Reflect.get(Object(Reflect.get(Object(error), "details")), "message"),
      ),
    };
  return {
    kind: "failed",
    reason: "authority-unavailable",
    detail: `${name}: ${String(Reflect.get(Object(error), "message"))}`,
  };
}

export function storeReceipt(value: unknown): StoreReceipt {
  const kind = text(value, "kind");
  if (kind === "rejected") {
    const detail: unknown = Reflect.get(Object(value), "detail");
    return {
      kind,
      reason: text(value, "reason"),
      ...(typeof detail === "string" ? { detail } : {}),
    };
  }
  if (kind !== "accepted" && kind !== "duplicate")
    throw new Error(`invalid-receipt: ${kind}`);
  const intents: unknown = Reflect.get(Object(value), "intents");
  if (!Array.isArray(intents)) throw new Error("invalid-receipt: intents");
  const disposition: unknown = Reflect.get(Object(value), "disposition");
  return {
    kind,
    sequence: integer(value, "sequence"),
    intents: intents.map((intent: unknown) => ({
      kind: intentKind(text(intent, "kind")),
      runId: text(intent, "runId"),
      operationId: text(intent, "operationId"),
    })),
    ...(typeof disposition === "string" ? { disposition } : {}),
  };
}

export function json(value: unknown): JsonObject {
  const copy: unknown = JSON.parse(JSON.stringify(value));
  if (!isJsonObject(copy)) throw new Error("invalid-json-object");
  return copy;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function textList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items: readonly unknown[] = value;
  return items.every((item) => typeof item === "string") ? items : undefined;
}

export function serializable(value: unknown): JsonObject | undefined {
  try {
    return json(value);
  } catch {
    return undefined;
  }
}
