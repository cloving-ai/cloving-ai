import type { Database, EffectContext, JsonObject } from "solid-objects";
import { isIdentifier } from "../../authority/commands.ts";
import { readExecutionManifest, resumePinned } from "../../execution-pin.ts";
import {
  optionalInteger,
  optionalText,
  text,
  type SqlConnection,
} from "../../storage/domain-rows.ts";
import type { ExecutionManifest } from "../../workflow-admission.ts";
import { intentKind } from "../authority-restore.ts";
import { intentDigest, type DeliveryIntent } from "./delivery-intents.ts";

export type { DeliveryIntent } from "./delivery-intents.ts";

export type Reconciliation =
  | { readonly kind: "accepted"; readonly receipt: string }
  | { readonly kind: "absent" };

export interface Delivery {
  readonly deliver: (
    intent: DeliveryIntent,
  ) => Promise<{ readonly receipt: string }>;
  readonly reconcile: (intent: DeliveryIntent) => Promise<Reconciliation>;
}

export type AvailableManifest = (
  pinned: ExecutionManifest,
) => ExecutionManifest | undefined;

export interface DeliveryParts {
  readonly reader: Database;
  readonly delivery: Delivery | undefined;
  readonly epoch: () => number;
  readonly available: AvailableManifest | undefined;
}

async function pinned(
  connection: SqlConnection,
  check: {
    readonly intent: DeliveryIntent;
    readonly available: AvailableManifest | undefined;
  },
): Promise<boolean> {
  const { intent, available } = check;
  if (intent.kind !== "continue-run" || available === undefined) return true;
  const stored = readExecutionManifest(
    JSON.parse(
      text(
        await connection.get("SELECT manifest FROM definitions WHERE pin = ?", [
          intent.workflow,
        ]),
        "manifest",
      ),
    ),
  );
  const current = available(stored);
  return (
    current !== undefined && resumePinned(stored, current).kind === "admitted"
  );
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
    const admission = await parts.reader.connection(async (connection) => {
      const row = await connection.get(
        "SELECT d.outcome, d.input_digest, o.released_sequence, r.status, r.workflow FROM deliveries d JOIN outbox o ON o.operation_id = d.operation_id JOIN runs r ON r.run_id = o.run_id WHERE d.effect_id = ? AND d.operation_id = ?",
        [context.id, intent.operationId],
      );
      if (!current(row, intent)) return "stale";
      if (!eligible(row, intent)) return "withheld";
      const admitted = await pinned(connection, {
        intent,
        available: parts.available,
      });
      return admitted ? "sent" : "blocked";
    });
    const settled = {
      epoch: parts.epoch(),
      recordedAt: new Date().toISOString(),
    };
    if (admission === "stale")
      return { kind: "withheld", receipt: null, ...settled };
    const known = acceptedReceipt(await delivery.reconcile(intent));
    if (known !== undefined)
      return { kind: "sent", receipt: known, ...settled };
    if (admission !== "sent")
      return { kind: admission, receipt: null, ...settled };
    const receipt = sentReceipt(await delivery.deliver(intent));
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

function current(row: unknown, intent: DeliveryIntent): boolean {
  return (
    row !== undefined &&
    Reflect.get(Object(row), "outcome") === null &&
    text(row, "input_digest") === intent.inputDigest &&
    intentDigest(intent) === intent.inputDigest &&
    text(row, "workflow") === intent.workflow
  );
}

function eligible(row: unknown, intent: DeliveryIntent): boolean {
  return (
    optionalInteger(row, "released_sequence") === null &&
    text(row, "status") === eligibleStatus[intent.kind]
  );
}

function argumentsIntent(value: JsonObject): DeliveryIntent {
  const base = {
    kind: intentKind(text(value, "kind")),
    runId: text(value, "runId"),
    operationId: text(value, "operationId"),
    workflow: text(value, "workflow"),
    inputDigest: text(value, "inputDigest"),
  };
  if (value["gateId"] === undefined) return base;
  return {
    ...base,
    gateId: text(value, "gateId"),
    decision: text(value, "decision"),
    answer: optionalText(value, "answer"),
  };
}
