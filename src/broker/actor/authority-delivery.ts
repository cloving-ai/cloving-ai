import type { Database, EffectContext, JsonObject } from "solid-objects";
import { isIdentifier } from "../../authority/commands.ts";
import { optionalInteger, text } from "../../storage/domain-rows.ts";
import { intentKind } from "../authority-restore.ts";
import { deliveryIntent, type DeliveryIntent } from "./turn-plan.ts";

export type { DeliveryIntent } from "./turn-plan.ts";

export type Reconciliation =
  | { readonly kind: "accepted"; readonly receipt: string }
  | { readonly kind: "absent" };

export interface Delivery {
  readonly deliver: (
    intent: DeliveryIntent,
  ) => Promise<{ readonly receipt: string }>;
  readonly reconcile: (intent: DeliveryIntent) => Promise<Reconciliation>;
}

export interface DeliveryParts {
  readonly reader: Database;
  readonly delivery: Delivery | undefined;
  readonly epoch: () => number;
}

const eligibleStatus: Readonly<Record<DeliveryIntent["kind"], string>> = {
  "start-run": "queued",
  "continue-run": "running",
};

export function deliveryHandler(
  parts: DeliveryParts,
): (argumentsValue: JsonObject, context: EffectContext) => Promise<JsonObject> {
  return async (argumentsValue, context) => {
    const { delivery } = parts;
    if (delivery === undefined) throw new Error("delivery-unconfigured");
    const intent = argumentsIntent(argumentsValue);
    const authorized = await parts.reader.connection(async (connection) =>
      deliverable(
        await connection.get(
          "SELECT d.outcome, d.input_digest, o.released_sequence, r.status, r.workflow FROM deliveries d JOIN outbox o ON o.operation_id = d.operation_id JOIN runs r ON r.run_id = o.run_id WHERE d.effect_id = ? AND d.operation_id = ?",
          [context.id, intent.operationId],
        ),
        intent,
      ),
    );
    const settled = {
      epoch: parts.epoch(),
      recordedAt: new Date().toISOString(),
    };
    if (!authorized) return { kind: "withheld", receipt: null, ...settled };
    const receipt =
      acceptedReceipt(await delivery.reconcile(intent)) ??
      sentReceipt(await delivery.deliver(intent));
    return { kind: "sent", receipt, ...settled };
  };
}

function acceptedReceipt(value: unknown): string | undefined {
  const kind: unknown = Reflect.get(Object(value), "kind");
  if (kind === "absent") return undefined;
  const receipt: unknown = Reflect.get(Object(value), "receipt");
  if (kind !== "accepted" || !isIdentifier(receipt))
    throw new Error("invalid-reconciliation");
  return receipt;
}

function sentReceipt(value: unknown): string {
  const receipt: unknown = Reflect.get(Object(value), "receipt");
  if (!isIdentifier(receipt)) throw new Error("invalid-delivery-receipt");
  return receipt;
}

function deliverable(row: unknown, intent: DeliveryIntent): boolean {
  return (
    row !== undefined &&
    Reflect.get(Object(row), "outcome") === null &&
    optionalInteger(row, "released_sequence") === null &&
    text(row, "input_digest") === intent.inputDigest &&
    deliveryIntent(intent, intent.workflow).inputDigest ===
      intent.inputDigest &&
    text(row, "workflow") === intent.workflow &&
    text(row, "status") === eligibleStatus[intent.kind]
  );
}

function argumentsIntent(value: JsonObject): DeliveryIntent {
  return {
    kind: intentKind(text(value, "kind")),
    runId: text(value, "runId"),
    operationId: text(value, "operationId"),
    workflow: text(value, "workflow"),
    inputDigest: text(value, "inputDigest"),
  };
}
