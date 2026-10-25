import type { Database, JsonObject } from "solid-objects";
import {
  dispatchDecision,
  type DispatchDecision,
  type DispatchRead,
} from "../../authority/dispatch-decision.ts";
import {
  integer,
  optionalInteger,
  optionalText,
  text,
  type SqlConnection,
} from "../../storage/domain-rows.ts";
import { budgetRow } from "../../storage/effect-rows.ts";
import { effectInputDigest, storedBudget } from "../effect-restore.ts";
import type { AdapterCalls } from "./adapter-calls.ts";
import { settlement, type Settlement } from "./adapter-outcomes.ts";
import type { EffectSettings } from "./authority-settings.ts";
import type {
  AvailableManifest,
  Delivery,
  EffectArguments,
  ProtectedIntent,
} from "./delivery-intents.ts";
import { pinned } from "./pin-check.ts";
import { commandLimits } from "../../command-settings.ts";

export interface EffectDelivery {
  readonly reader: Database;
  readonly delivery: Delivery;
  readonly available: AvailableManifest | undefined;
  readonly epoch: () => number;
  readonly clock: () => string;
  readonly calls: AdapterCalls;
  readonly effects: EffectSettings;
}

export interface Attempt {
  readonly intent: ProtectedIntent;
  readonly effectId: string;
}

const absent: DispatchRead = {
  attempt: undefined,
  released: false,
  runStatus: "",
  workflow: "",
  pinned: false,
  operation: undefined,
  lease: undefined,
  budget: undefined,
};

async function dispatchRead(
  connection: SqlConnection,
  attempt: Attempt & { readonly available: AvailableManifest | undefined },
): Promise<DispatchRead> {
  const row = await connection.get(
    "SELECT d.outcome, d.input_digest, a.lease_generation, o.released_sequence, r.status, r.workflow, p.status AS operation_status, p.capability, p.units, l.operation_id AS lease_owner, l.generation, l.expires_at, l.state AS lease_state, b.run_id, b.effect_limit, b.spent, b.capabilities, b.exhausted_sequence FROM deliveries d JOIN outbox o ON o.operation_id = d.operation_id JOIN runs r ON r.run_id = o.run_id JOIN dispatch_attempts a ON a.effect_id = d.effect_id JOIN operations p ON p.operation_id = d.operation_id JOIN leases l ON l.resource_key = p.lease_key JOIN run_budgets b ON b.run_id = o.run_id WHERE d.effect_id = ? AND d.operation_id = ?",
    [attempt.effectId, attempt.intent.operationId],
  );
  if (row === undefined) return absent;
  const workflow = text(row, "workflow");
  return {
    attempt: {
      outcome: optionalText(row, "outcome"),
      inputDigest: text(row, "input_digest"),
      leaseGeneration: optionalInteger(row, "lease_generation"),
    },
    released: optionalInteger(row, "released_sequence") !== null,
    runStatus: text(row, "status"),
    workflow,
    pinned: await pinned(connection, {
      workflow,
      available: attempt.available,
    }),
    operation: {
      status: text(row, "operation_status"),
      capability: text(row, "capability"),
      units: integer(row, "units"),
    },
    budget: storedBudget(budgetRow(row)),
    lease: {
      operationId: text(row, "lease_owner"),
      generation: integer(row, "generation"),
      expiresAt: text(row, "expires_at"),
      state: text(row, "lease_state"),
    },
  };
}

type Result =
  Settlement | { readonly kind: "withheld" | "refused" | "blocked" };

async function called(
  parts: EffectDelivery,
  call: {
    readonly intent: ProtectedIntent;
    readonly name: "reconcile" | "deliver" | "stop" | "retry";
  },
): Promise<Settlement> {
  const { intent, name } = call;
  const adapterCall = parts.delivery[name]?.bind(parts.delivery);
  if (adapterCall === undefined)
    return { kind: "unknown", reason: "stop-not-supported" };
  return settlement(
    await parts.calls.call(intent.operationId, (signal) =>
      adapterCall(intent, signal),
    ),
    intent.capability === "command"
      ? commandLimits.resultBytes
      : parts.effects.resultBytes,
  );
}

const confirmations = ["stopped", "completed", "failed"];

async function stopRequested(
  parts: EffectDelivery,
  intent: ProtectedIntent,
): Promise<Settlement> {
  const stopped = await called(parts, { intent, name: "stop" });
  return confirmations.includes(stopped.kind)
    ? stopped
    : called(parts, { intent, name: "reconcile" });
}

function decided(
  parts: EffectDelivery,
  attempt: Attempt & { readonly mode?: "retry" },
): Promise<DispatchDecision> {
  const { intent } = attempt;
  const now = parts.clock();
  return parts.reader.connection(async (connection) =>
    dispatchDecision(
      await dispatchRead(connection, {
        ...attempt,
        available: parts.available,
      }),
      {
        intent: { ...intent, computedDigest: effectInputDigest(intent) },
        now,
        ...(attempt.mode === undefined ? {} : { mode: attempt.mode }),
      },
    ),
  );
}

const withheld: Result = { kind: "withheld" };

async function retryEffect(
  parts: EffectDelivery,
  attempt: Attempt & { readonly known: Settlement },
): Promise<Settlement> {
  const retry = await decided(parts, { ...attempt, mode: "retry" });
  return retry === "send"
    ? called(parts, { intent: attempt.intent, name: "retry" })
    : attempt.known;
}

function unsent(decision: Exclude<DispatchDecision, "send">): Result {
  return decision === "stale" ? withheld : { kind: decision };
}

async function attempted(
  parts: EffectDelivery,
  attempt: Attempt,
): Promise<Result> {
  const { intent } = attempt;
  const first = await decided(parts, attempt);
  if (first === "stale") return withheld;
  if (intent.purpose === "stop") return stopRequested(parts, intent);
  const known = await called(parts, { intent, name: "reconcile" });
  if (known.kind === "unknown" && parts.delivery.retry !== undefined)
    return retryEffect(parts, { ...attempt, known });
  if (known.kind !== "absent" || intent.purpose === "reconcile") return known;
  if (first !== "send") return unsent(first);
  const second = await decided(parts, attempt);
  if (second !== "send") return unsent(second);
  const sent = await called(parts, { intent, name: "deliver" });
  return sent.kind === "absent"
    ? { kind: "unknown", reason: "invalid-adapter-reply" }
    : sent;
}

export async function deliverEffect(
  parts: EffectDelivery,
  attempt: Attempt,
): Promise<JsonObject> {
  const result = await attempted(parts, attempt);
  return {
    receipt: null,
    worker: null,
    result: null,
    reason: null,
    ...result,
    epoch: parts.epoch(),
    recordedAt: parts.clock(),
  };
}

export function protectedArguments(value: JsonObject): EffectArguments {
  return {
    leaseGeneration: integer(value, "leaseGeneration"),
    capability: text(value, "capability"),
    method: text(value, "method"),
    target: text(value, "target"),
    payload: text(value, "payload"),
  };
}
