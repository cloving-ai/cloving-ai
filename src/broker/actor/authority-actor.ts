import {
  Actor,
  type ActorClass,
  type Database,
  type JsonObject,
} from "solid-objects";
import {
  integer,
  optionalInteger,
  optionalText,
  text,
} from "../../storage/domain-rows.ts";
import { readExecutionManifest } from "../../execution-pin.ts";
import {
  planAdoption,
  planCommand,
  planDelivery,
  planRecovery,
  type DeliveryResult,
  type TurnPlan,
  type TurnRequest,
} from "./turn-plan.ts";
import { json } from "./authority-session.ts";
import {
  adoptionTurn,
  commandTurn,
  deliveryTurn,
  recoverableIntents,
} from "./turn-state.ts";

export const deliverEffect = "cloving.deliver";
export const persistAction = "cloving.persist";

type Outcome = Pick<
  DeliveryResult,
  "effectId" | "outcome" | "receipt" | "epoch" | "recordedAt"
> & { readonly operationId: string; readonly inputDigest: string };

export function authorityActor(reader: Database): AuthorityActorClass {
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
      return executeCommand(this, { reader, request });
    }

    async adopt(): Promise<JsonObject> {
      return applyPlan(
        this,
        planAdoption(await reader.connection(adoptionTurn)),
      );
    }

    async recover(): Promise<JsonObject> {
      return applyPlan(
        this,
        planRecovery({
          sequence: this.sequence,
          intents: await reader.connection(recoverableIntents),
        }),
      );
    }

    deliveryCompleted(payload: JsonObject): Promise<JsonObject> {
      return settleDelivery(this, { reader, outcome: completed(payload) });
    }

    deliveryFailed(payload: JsonObject): Promise<JsonObject> {
      return settleDelivery(this, {
        reader,
        outcome: {
          ...callback(payload),
          outcome: "failed",
          receipt: null,
          epoch: this.epoch,
          recordedAt: "",
        },
      });
    }
  };
}

type AuthorityInstance = InstanceType<AuthorityActorClass>;

async function executeCommand(
  actor: AuthorityInstance,
  input: { readonly reader: Database; readonly request: JsonObject },
): Promise<JsonObject> {
  const { reader, request } = input;
  const turn = await reader.connection((connection) =>
    commandTurn(connection, {
      command: request["command"],
      sequence: actor.sequence,
    }),
  );
  return applyPlan(
    actor,
    planCommand({ turn, request: turnRequest(request), epoch: actor.epoch }),
  );
}

async function settleDelivery(
  actor: AuthorityInstance,
  input: { readonly reader: Database; readonly outcome: Outcome },
): Promise<JsonObject> {
  const { reader, outcome } = input;
  const found = await reader.connection((connection) =>
    deliveryTurn(connection, {
      effectId: outcome.effectId,
      sequence: actor.sequence,
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
      delivery: { ...outcome, runId: found.runId },
      epoch: actor.epoch,
    }),
  );
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

function completed(payload: JsonObject): Outcome {
  const result: unknown = payload["result"];
  return {
    ...callback(payload),
    outcome: resultKind(text(result, "kind")),
    receipt: optionalText(result, "receipt"),
    epoch: integer(result, "epoch"),
    recordedAt: text(result, "recordedAt"),
  };
}

function resultKind(kind: string): "sent" | "withheld" {
  if (kind !== "sent" && kind !== "withheld")
    throw new Error(`invalid-delivery-result: ${kind}`);
  return kind;
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

function turnRequest(request: JsonObject): TurnRequest {
  const manifest = request["manifest"];
  const epoch = optionalInteger(request, "epoch");
  return {
    command: request["command"],
    recordedAt: text(request, "recordedAt"),
    ...(manifest === undefined || manifest === null
      ? {}
      : { manifest: readExecutionManifest(manifest) }),
    ...(epoch === null ? {} : { epoch }),
  };
}
