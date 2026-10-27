import type { Database, EffectContext, JsonObject } from "solid-objects";
import { isIdentifier } from "../../authority/commands.ts";
import {
  optionalInteger,
  optionalText,
  text,
} from "../../storage/domain-rows.ts";
import { intentKind } from "../authority-restore.ts";
import {
  intentDigest,
  type AvailableManifest,
  type Delivery,
  type DeliveryIntent,
  type Purpose,
} from "./delivery-intents.ts";
import {
  adapterCalls,
  type AdapterCalls,
  type CallResult,
} from "./adapter-calls.ts";
import type { EffectSettings } from "./authority-settings.ts";
import { deliverEffect, protectedArguments } from "./effect-delivery.ts";
import { pinned } from "./pin-check.ts";

export type {
  AdapterOutcome,
  AvailableManifest,
  Delivery,
  DeliveryIntent,
  Reconciliation,
} from "./delivery-intents.ts";

export interface DeliveryParts {
  readonly reader: Database;
  readonly delivery: Delivery | undefined;
  readonly epoch: () => number;
  readonly clock: () => string;
  readonly available: AvailableManifest | undefined;
  readonly effects: EffectSettings;
}

const eligibleStatus: Readonly<Record<string, string>> = {
  "start-run": "queued",
  "continue-run": "running",
  "resume-hook": "running",
};

interface RunAttempt {
  readonly intent: DeliveryIntent;
  readonly effectId: string;
  readonly delivery: Delivery;
  readonly calls: AdapterCalls;
}

type Admission = "stale" | "withheld" | "blocked" | "sent";

function admission(
  parts: DeliveryParts,
  attempt: RunAttempt,
): Promise<Admission> {
  const { intent, effectId } = attempt;
  return parts.reader.connection(async (connection) => {
    const row = await connection.get(
      "SELECT d.outcome, d.input_digest, o.released_sequence, r.status, r.workflow FROM deliveries d JOIN outbox o ON o.operation_id = d.operation_id JOIN runs r ON r.run_id = o.run_id WHERE d.effect_id = ? AND d.operation_id = ?",
      [effectId, intent.operationId],
    );
    if (!current(row, intent)) return "stale";
    if (!eligible(row, intent)) return "withheld";
    const admitted = await pinned(connection, {
      workflow: intent.workflow,
      available: parts.available,
    });
    return admitted ? "sent" : "blocked";
  });
}

async function called(
  attempt: RunAttempt,
  name: "reconcile" | "deliver",
): Promise<unknown> {
  const { intent, delivery, calls } = attempt;
  const result = await calls.call(intent.operationId, (signal) =>
    delivery[name](intent, signal),
  );
  if (result.kind === "replied") return result.reply;
  throw new Error(
    result.kind === "thrown" ? result.message : "adapter-time-limit",
  );
}

type Observation =
  | { readonly kind: "stopped" | "absent" | "unknown" }
  | { readonly kind: "sent"; readonly receipt: string };

const confirmations = ["stopped", "completed", "failed"];

function observation(result: CallResult<unknown>): Observation {
  if (result.kind !== "replied") return { kind: "unknown" };
  const kind: unknown = Reflect.get(Object(result.reply), "kind");
  const receipt: unknown = Reflect.get(Object(result.reply), "receipt");
  if (typeof kind === "string" && confirmations.includes(kind))
    return { kind: "stopped" };
  if (kind === "absent") return { kind: "absent" };
  return kind === "accepted" && isIdentifier(receipt)
    ? { kind: "sent", receipt }
    : { kind: "unknown" };
}

async function observed(
  attempt: RunAttempt,
  name: "reconcile" | "stop",
): Promise<Observation> {
  const { intent, delivery, calls } = attempt;
  const call = delivery[name]?.bind(delivery);
  if (call === undefined) return { kind: "unknown" };
  return observation(
    await calls.call(intent.operationId, (signal) => call(intent, signal)),
  );
}

async function observeRun(
  parts: DeliveryParts,
  attempt: RunAttempt,
): Promise<JsonObject> {
  const { intent, effectId } = attempt;
  const open = await parts.reader.connection(async (connection) =>
    current(
      await connection.get(
        "SELECT d.outcome, d.input_digest, r.workflow FROM deliveries d JOIN outbox o ON o.operation_id = d.operation_id JOIN runs r ON r.run_id = o.run_id WHERE d.effect_id = ? AND d.operation_id = ?",
        [effectId, intent.operationId],
      ),
      intent,
    ),
  );
  const result = open ? await requested(attempt) : { kind: "withheld" };
  return {
    receipt: null,
    ...result,
    epoch: parts.epoch(),
    recordedAt: parts.clock(),
  };
}

async function requested(attempt: RunAttempt): Promise<Observation> {
  if (attempt.intent.purpose !== "stop") return observed(attempt, "reconcile");
  const stopped = await observed(attempt, "stop");
  return stopped.kind === "stopped" ? stopped : observed(attempt, "reconcile");
}

async function deliverRun(
  parts: DeliveryParts,
  attempt: RunAttempt,
): Promise<JsonObject> {
  if (attempt.intent.purpose !== "dispatch") return observeRun(parts, attempt);
  const first = await admission(parts, attempt);
  const settled = { epoch: parts.epoch(), recordedAt: parts.clock() };
  const unsent = (kind: Admission): JsonObject => ({
    kind: kind === "stale" ? "withheld" : kind,
    receipt: null,
    ...settled,
  });
  if (first === "stale") return unsent(first);
  const known = acceptedReceipt(await called(attempt, "reconcile"));
  if (known !== undefined) return { kind: "sent", receipt: known, ...settled };
  if (first !== "sent") return unsent(first);
  const second = await admission(parts, attempt);
  if (second !== "sent") return unsent(second);
  const receipt = sentReceipt(await called(attempt, "deliver"));
  return { kind: "sent", receipt, ...settled };
}

export function deliveryHandler(
  parts: DeliveryParts,
): (argumentsValue: JsonObject, context: EffectContext) => Promise<JsonObject> {
  const calls = adapterCalls(parts.effects.adapterMilliseconds);
  return async (argumentsValue, context) => {
    const { delivery } = parts;
    if (delivery === undefined) throw new Error("delivery-unconfigured");
    const intent = argumentsIntent(argumentsValue);
    if (intent.kind !== "protected-effect")
      return deliverRun(parts, {
        intent,
        effectId: context.id,
        delivery,
        calls,
      });
    return deliverEffect(
      { ...parts, delivery, calls },
      {
        intent: { ...intent, ...protectedArguments(argumentsValue) },
        effectId: context.id,
      },
    );
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

const purposes = ["reconcile", "stop"] as const;

function purposeOf(value: unknown): Purpose {
  return purposes.find((purpose) => purpose === value) ?? "dispatch";
}

function argumentsIntent(value: JsonObject): DeliveryIntent {
  const base = {
    kind: intentKind(text(value, "kind")),
    runId: text(value, "runId"),
    operationId: text(value, "operationId"),
    workflow: text(value, "workflow"),
    inputDigest: text(value, "inputDigest"),
    purpose: purposeOf(value["purpose"]),
  };
  if (value["gateId"] === undefined) return base;
  return {
    ...base,
    gateId: text(value, "gateId"),
    decision: text(value, "decision"),
    answer: optionalText(value, "answer"),
  };
}
