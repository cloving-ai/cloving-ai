import { parseCommand } from "../../authority/commands.ts";
import {
  execute,
  type AuthorityState,
  type CommandResult,
  type EffectIntent,
} from "../../authority/reducer.ts";
import type { AuthorityCommand } from "../../authority/transitions.ts";
import type { ExecutionManifest } from "../../workflow-admission.ts";
import { admitted, type Definitions } from "../authority-admission.ts";
import { detailRecord, gateRecord } from "../decision-restore.ts";
import { operationDigest } from "../operation-digest.ts";
import { stageable, type DeliveryIntent } from "./delivery-intents.ts";

export type { DeliveryIntent } from "./delivery-intents.ts";

export interface TurnState {
  readonly state: AuthorityState;
  readonly definitions: Definitions;
  readonly held: ReadonlySet<string>;
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

export type Row = Readonly<Record<string, unknown>>;

export interface ChangeDraft {
  readonly previous: number;
  readonly sequence: number;
  readonly definitions: readonly Row[];
  readonly events: readonly Row[];
  readonly runs: readonly Row[];
  readonly commands: readonly Row[];
  readonly added: readonly Row[];
  readonly released: readonly Row[];
  readonly closed: readonly Row[];
  readonly gates: readonly Row[];
  readonly details: readonly Row[];
  readonly documents: readonly Row[];
  readonly completes_adoption?: true;
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
  readonly outcome: "sent" | "withheld" | "blocked" | "failed";
  readonly receipt: string | null;
  readonly epoch: number;
  readonly recordedAt: string;
}

type Accepted = Extract<CommandResult, { kind: "accepted" }>;

export interface CommandPlanning {
  readonly turn: TurnState;
  readonly request: TurnRequest;
  readonly epoch: number;
}

export interface DeliveryPlanning {
  readonly turn: TurnState;
  readonly delivery: DeliveryResult;
  readonly epoch: number;
}

export function planCommand(planning: CommandPlanning): TurnPlan {
  const { turn, request } = planning;
  const refusal = freshRefusal(planning);
  if (refusal !== undefined) return answer(refusal);
  const admission = admitted(turn.state, {
    definitions: turn.definitions,
    command: request.command,
    manifest: request.manifest,
  });
  if (admission.kind === "rejected") return answer(admission);
  const missing = missingDocument(planning);
  if (missing !== undefined)
    return answer({
      kind: "rejected",
      reason: "missing-document",
      detail: missing,
    });
  const result = execute(turn.state, request);
  if (result.kind === "duplicate")
    return answer({ ...result, intents: turn.created });
  if (result.kind === "rejected") return answer(result);
  return {
    kind: "commit",
    receipt: {
      kind: "accepted",
      sequence: result.state.sequence,
      intents: result.intents,
    },
    change: draft(result, {
      before: turn.state,
      definitions: [...admission.definitions].map(([pin, manifest]) => ({
        pin,
        manifest: JSON.stringify(manifest),
      })),
      closed: [],
      documents: referencedDocuments(request),
    }),
    stage: stageable(result.state, turn.held),
  };
}

const documentFields = ["submission", "input", "prompt", "answer"] as const;

export function documentReferences(
  command: AuthorityCommand | null,
): readonly string[] {
  if (command === null) return [];
  return documentFields
    .map((name) => command[name])
    .filter((digest) => digest !== undefined);
}

function referencedDocuments(request: TurnRequest): readonly Row[] {
  const references = documentReferences(parseCommand(request.command));
  return (request.documents ?? [])
    .filter((document) => references.includes(document.digest))
    .map((document) => ({ digest: document.digest, body: document.body }));
}

function missingDocument(planning: CommandPlanning): string | undefined {
  const { turn, request } = planning;
  const command = parseCommand(request.command);
  if (command === null || turn.state.commands[command.commandId] !== undefined)
    return undefined;
  const given = new Set(
    (request.documents ?? []).map((document) => document.digest),
  );
  return documentReferences(command).find(
    (digest) => !given.has(digest) && !turn.documents.has(digest),
  );
}

function freshRefusal(planning: CommandPlanning): Row | undefined {
  const { turn, request, epoch } = planning;
  const command = parseCommand(request.command);
  if (command === null || turn.state.commands[command.commandId] !== undefined)
    return undefined;
  if (request.epoch !== undefined && request.epoch !== epoch)
    return { kind: "rejected", reason: "stale-epoch" };
  if (command.kind === "record-dispatch")
    return { kind: "rejected", reason: "delivery-owned-command" };
  return undefined;
}

export function planDelivery(planning: DeliveryPlanning): TurnPlan {
  const { turn, delivery, epoch } = planning;
  const outcome = delivery.epoch === epoch ? delivery.outcome : "stale-epoch";
  const closed = [
    { effect_id: delivery.effectId, outcome, receipt: delivery.receipt },
  ];
  const held = new Set(
    [...turn.held].filter((operation) => operation !== delivery.operationId),
  );
  const result =
    outcome === "sent" ? dispatched(turn.state, delivery) : undefined;
  const after = result?.state ?? turn.state;
  return {
    kind: "commit",
    receipt: { kind: outcome },
    change: result
      ? draft(result, {
          before: turn.state,
          definitions: [],
          closed,
          documents: [],
        })
      : unchanged(turn.state, closed),
    stage: ["failed", "blocked"].includes(outcome)
      ? []
      : stageable(after, held),
  };
}

export function planAdoption(sequence: number): TurnPlan {
  return {
    kind: "commit",
    receipt: { kind: "adopted", sequence },
    change: { ...unchangedAt(sequence, []), completes_adoption: true },
    stage: [],
  };
}

export function planRecovery(recovery: {
  readonly sequence: number;
  readonly intents: readonly DeliveryIntent[];
}): TurnPlan {
  const { sequence, intents } = recovery;
  const receipt = { kind: "recovered", staged: intents.length };
  if (intents.length === 0) return answer(receipt);
  return {
    kind: "commit",
    receipt,
    change: unchangedAt(sequence, []),
    stage: intents,
  };
}

function dispatched(
  state: AuthorityState,
  delivery: DeliveryResult,
): Accepted | undefined {
  const result = execute(state, {
    command: {
      kind: "record-dispatch",
      commandId: `dispatch:${operationDigest(delivery.operationId)}`,
      runId: delivery.runId,
      operationId: delivery.operationId,
      receipt: delivery.receipt,
    },
    recordedAt: delivery.recordedAt,
  });
  return result.kind === "accepted" ? result : undefined;
}

function answer(receipt: Row): TurnPlan {
  return { kind: "answer", receipt };
}

function unchanged(state: AuthorityState, closed: readonly Row[]): ChangeDraft {
  return unchangedAt(state.sequence, closed);
}

function unchangedAt(sequence: number, closed: readonly Row[]): ChangeDraft {
  return {
    previous: sequence,
    sequence,
    definitions: [],
    events: [],
    runs: [],
    commands: [],
    added: [],
    released: [],
    closed,
    gates: [],
    details: [],
    documents: [],
  };
}

function columns(row: object): Row {
  return Object.fromEntries(
    Object.entries(row).map(([name, value]) => [
      name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
      value,
    ]),
  );
}

function changed<Value>(
  after: Readonly<Record<string, Value>>,
  before: Readonly<Record<string, Value>>,
): readonly Value[] {
  return Object.entries(after)
    .filter(([key, value]) => before[key] !== value)
    .map(([, value]) => value);
}

function draft(
  result: Accepted,
  extra: Pick<ChangeDraft, "definitions" | "closed" | "documents"> & {
    readonly before: AuthorityState;
  },
): ChangeDraft {
  const { state, events, intents } = result;
  const { before, definitions, closed, documents } = extra;
  const touched = new Set(events.map((event) => event.runId));
  const retained = new Set(state.intents.map((intent) => intent.operationId));
  return {
    definitions,
    closed,
    documents,
    gates: changed(state.gates, before.gates).map((gate) =>
      columns(gateRecord(gate)),
    ),
    details: changed(state.details, before.details).map((details) =>
      columns(detailRecord(details)),
    ),
    previous: before.sequence,
    sequence: state.sequence,
    events: events.map((event) => ({
      sequence: event.sequence,
      type: event.type,
      run_id: event.runId,
      command_id: event.commandId,
      recorded_at: event.recordedAt,
      request: event.request,
      payload: JSON.stringify(event.payload),
    })),
    runs: Object.values(state.runs)
      .filter((run) => touched.has(run.runId))
      .map((run) => ({
        run_id: run.runId,
        status: run.status,
        revision: run.revision,
        workflow: run.workflow,
        paused_from: run.pausedFrom,
        gates: JSON.stringify(run.gates),
        sequence: state.sequence,
      })),
    commands: events.map((event) => ({
      command_id: event.commandId,
      request: event.request,
      sequence: event.sequence,
    })),
    added: intents.map((intent) => ({
      operation_id: intent.operationId,
      kind: intent.kind,
      run_id: intent.runId,
    })),
    released: before.intents
      .filter((intent) => !retained.has(intent.operationId))
      .map((intent) => ({ operation_id: intent.operationId })),
  };
}
