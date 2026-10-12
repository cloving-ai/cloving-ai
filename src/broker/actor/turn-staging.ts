import type { AuthorityState, EffectIntent } from "../../authority/reducer.ts";
import type { ExecutionManifest } from "../../workflow-admission.ts";
import type { Definitions } from "../authority-admission.ts";
import type { PlanSettings } from "./authority-settings.ts";
import { stageable, type DeliveryIntent } from "./delivery-intents.ts";
import {
  reconciliations,
  rejectedReports,
  type Reconciling,
  type Step,
} from "./effect-plan.ts";
import { stopIntents, type ClosedRow } from "./stop-plan.ts";
import type { Stopping } from "./stop-turn.ts";
import { draft, type ChangeDraft, type Row } from "./turn-draft.ts";

export interface TurnState {
  readonly state: AuthorityState;
  readonly definitions: Definitions;
  readonly held: ReadonlySet<string>;
  readonly blocked: ReadonlyMap<string, string>;
  readonly stopping: Stopping;
  readonly runId: string;
  readonly created: readonly EffectIntent[];
  readonly documents: ReadonlySet<string>;
}

export interface Document {
  readonly digest: string;
  readonly body: string;
}

export interface TurnRequest {
  readonly command: unknown;
  readonly recordedAt: string;
  readonly manifest?: ExecutionManifest;
  readonly epoch?: number;
  readonly documents?: readonly Document[];
}

export type TurnPlan =
  | { readonly kind: "answer"; readonly receipt: Row }
  | {
      readonly kind: "commit";
      readonly receipt: Row;
      readonly change: ChangeDraft;
      readonly stage: readonly DeliveryIntent[];
    };

export interface DeliveryResult {
  readonly effectId: string;
  readonly operationId: string;
  readonly runId: string;
  readonly intent: EffectIntent["kind"];
  readonly leaseGeneration: number | null;
  readonly purpose: string;
  readonly attempts: number;
  readonly outcome:
    | "sent"
    | "withheld"
    | "blocked"
    | "thrown"
    | "failed"
    | "accepted"
    | "refused"
    | "completed"
    | "stopped"
    | "unknown"
    | "absent";
  readonly receipt: string | null;
  readonly worker: string | null;
  readonly result: string | null;
  readonly reason: string | null;
  readonly epoch: number;
  readonly recordedAt: string;
}

export interface CommandPlanning {
  readonly turn: TurnState;
  readonly request: TurnRequest;
  readonly epoch: number;
  readonly effects: PlanSettings;
}

export interface DeliveryPlanning {
  readonly turn: TurnState;
  readonly delivery: DeliveryResult;
  readonly epoch: number;
  readonly effects: PlanSettings;
}

export function openAttempts(
  turn: TurnState,
  closed: readonly string[],
): ReadonlySet<string> {
  return new Set(
    [...turn.held].filter(
      (operation) =>
        !turn.blocked.has(operation) && !closed.includes(operation),
    ),
  );
}

export interface Staging extends Reconciling {
  readonly held: ReadonlySet<string>;
  readonly stop: {
    readonly turn: TurnState;
    readonly effects: PlanSettings;
    readonly rows: readonly ClosedRow[];
  };
}

export function staged(
  state: AuthorityState,
  staging: Staging,
): readonly DeliveryIntent[] {
  const { turn, effects, rows } = staging.stop;
  return [
    ...stageable(state, staging.held),
    ...reconciliations(state, staging),
    ...stopIntents(state, {
      stopping: turn.stopping,
      runId: turn.runId,
      closed: rows,
      cancelledNow: staging.results.flatMap((result) =>
        result.events
          .filter((event) => event.type === "run.cancelled")
          .map((event) => event.sequence),
      ),
      stopLimit: effects.stopLimit,
      stopSupported: effects.stopSupported,
      opening: false,
      rejected: rejectedReports(staging.results),
    }),
  ];
}

export function followUp(step: Step): ChangeDraft {
  return draft(step.result, {
    before: step.before,
    definitions: [],
    closed: [],
    documents: [],
  });
}
