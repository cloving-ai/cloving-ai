import {
  Actor,
  type ActorClass,
  type Database,
  type JsonObject,
} from "solid-objects";
import { optionalInteger, text } from "../../storage/domain-rows.ts";
import { parseCommand } from "../../authority/commands.ts";
import { readExecutionManifest } from "../../execution-pin.ts";
import { documentDigest } from "../decision-restore.ts";
import {
  planAdoption,
  planCommand,
  planDelivery,
  planRecovery,
  type TurnPlan,
  type TurnRequest,
} from "./turn-plan.ts";
import { json, textList } from "./authority-receipts.ts";
import {
  completedOutcome,
  thrownOutcome,
  type Outcome,
  type Present,
} from "./delivery-results.ts";
import type { PlanSettings } from "./authority-settings.ts";
import {
  adoptionTurn,
  commandTurn,
  deliveryTurn,
  recoverableIntents,
  recoveryTurn,
  stopRecoveries,
} from "./turn-state.ts";

export const deliverEffect = "cloving.deliver";
export const persistAction = "cloving.persist";

export interface ActorParts {
  readonly reader: Database;
  readonly effects: PlanSettings;
  readonly clock: () => string;
  readonly failed: (delivery: {
    readonly operationId: string;
    readonly effectId: string;
  }) => number;
}

export function authorityActor(parts: ActorParts): AuthorityActorClass {
  const { reader } = parts;
  return class ClovingAuthority extends Actor {
    static override readonly actorType = "ClovingAuthority";
    static override readonly stateVersion = 1;

    sequence = 0;
    epoch = 0;

    beginEpoch(): JsonObject {
      this.epoch += 1;
      return { epoch: this.epoch, sequence: this.sequence };
    }

    execute(request: JsonObject): Promise<JsonObject> {
      return executeCommand(this, { parts, request });
    }

    async adopt(): Promise<JsonObject> {
      return applyPlan(
        this,
        planAdoption(await reader.connection(adoptionTurn)),
      );
    }

    recover(): Promise<JsonObject> {
      return recoverTurn(this, parts);
    }

    deliveryCompleted(payload: JsonObject): Promise<JsonObject> {
      return settleDelivery(this, {
        parts,
        outcome: completedOutcome(payload, present(this, parts)),
      });
    }

    deliveryFailed(payload: JsonObject): Promise<JsonObject> {
      return settleDelivery(this, {
        parts,
        outcome: thrownOutcome(payload, present(this, parts)),
      });
    }
  };
}

type AuthorityInstance = InstanceType<AuthorityActorClass>;

async function recoverTurn(
  actor: AuthorityInstance,
  parts: ActorParts,
): Promise<JsonObject> {
  const scope = { sequence: actor.sequence, capacity: parts.effects.capacity };
  return applyPlan(
    actor,
    planRecovery({
      ...(await parts.reader.connection(async (connection) => ({
        intents: [
          ...(await recoverableIntents(connection)),
          ...(await stopRecoveries(connection, {
            capacity: parts.effects.capacity,
            stopLimit: parts.effects.stopLimit,
            stopSupported: parts.effects.stopSupported,
          })),
        ],
        turn: await recoveryTurn(connection, scope),
      }))),
      effects: parts.effects,
      recordedAt: parts.clock(),
    }),
  );
}

async function executeCommand(
  actor: AuthorityInstance,
  input: { readonly parts: ActorParts; readonly request: JsonObject },
): Promise<JsonObject> {
  const { parts, request } = input;
  const turn = await parts.reader.connection((connection) =>
    commandTurn(connection, {
      command: request["command"],
      sequence: actor.sequence,
      capacity: parts.effects.capacity,
    }),
  );
  return applyPlan(
    actor,
    planCommand({
      turn,
      request: turnRequest(request),
      epoch: actor.epoch,
      effects: parts.effects,
    }),
  );
}

async function settleDelivery(
  actor: AuthorityInstance,
  input: { readonly parts: ActorParts; readonly outcome: Outcome },
): Promise<JsonObject> {
  const { parts, outcome } = input;
  const found = await parts.reader.connection((connection) =>
    deliveryTurn(connection, {
      effectId: outcome.effectId,
      sequence: actor.sequence,
      capacity: parts.effects.capacity,
    }),
  );
  if (
    found?.delivery.outcome !== null ||
    found.delivery.operationId !== outcome.operationId ||
    found.delivery.inputDigest !== outcome.inputDigest
  )
    actor.reject("stale_callback", {
      message: "the callback does not match an open delivery",
    });
  return applyPlan(
    actor,
    planDelivery({
      turn: found.turn,
      delivery: {
        ...outcome,
        runId: found.runId,
        intent: found.intent,
        leaseGeneration: found.leaseGeneration,
        purpose: found.purpose,
        attempts: failures(parts, outcome),
      },
      epoch: actor.epoch,
      effects: parts.effects,
    }),
  );
}

function failures(parts: ActorParts, outcome: Outcome): number {
  return outcome.outcome === "thrown" ? parts.failed(outcome) : 0;
}

function applyPlan(actor: AuthorityInstance, plan: TurnPlan): JsonObject {
  if (plan.kind === "answer") return json(plan.receipt);
  const staged = plan.stage.map((intent) => ({
    effect_id: actor.emit(deliverEffect, {
      arguments: { ...intent },
      onSuccess: "deliveryCompleted",
      onFailure: "deliveryFailed",
    }).id,
    operation_id: intent.operationId,
    input_digest: intent.inputDigest,
    purpose: intent.purpose,
    lease_generation: intent.leaseGeneration ?? null,
    authority_epoch: actor.epoch,
  }));
  actor.commitAction(persistAction, { ...plan.change, staged });
  actor.sequence = plan.change.sequence;
  return json(plan.receipt);
}

export type AuthorityActorClass = ActorClass<
  Actor & {
    sequence: number;
    epoch: number;
    beginEpoch: () => JsonObject;
    execute: (request: JsonObject) => Promise<JsonObject>;
    adopt: () => Promise<JsonObject>;
    recover: () => Promise<JsonObject>;
    deliveryCompleted: (payload: JsonObject) => Promise<JsonObject>;
    deliveryFailed: (payload: JsonObject) => Promise<JsonObject>;
  }
>;

function present(
  actor: { readonly epoch: number },
  parts: ActorParts,
): Present {
  return { epoch: actor.epoch, recordedAt: parts.clock() };
}

export function checkedRequest(given: JsonObject): JsonObject | undefined {
  const bodies = textList(given["documents"]);
  if (bodies === undefined || parseCommand(given["command"]) === null)
    return undefined;
  const documents = bodies.map((body) => ({
    digest: documentDigest(body),
    body,
  }));
  try {
    const request = turnRequest({ ...given, documents });
    return json({
      ...request,
      manifest: request.manifest ?? null,
      epoch: request.epoch ?? null,
    });
  } catch {
    return undefined;
  }
}

function turnRequest(request: JsonObject): TurnRequest {
  const manifest = request["manifest"];
  const epoch = optionalInteger(request, "epoch");
  const documents: unknown = request["documents"];
  return {
    command: request["command"],
    recordedAt: text(request, "recordedAt"),
    documents: (Array.isArray(documents) ? documents : []).map(
      (document: unknown) => ({
        digest: text(document, "digest"),
        body: text(document, "body"),
      }),
    ),
    ...(manifest === undefined || manifest === null
      ? {}
      : { manifest: readExecutionManifest(manifest) }),
    ...(epoch === null ? {} : { epoch }),
  };
}
