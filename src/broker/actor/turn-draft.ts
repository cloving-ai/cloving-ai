import { commandWaitRows } from "../command-wait-restore.ts";
import { evidenceOf } from "../../authority/operations.ts";
import type { AuthorityState, CommandResult } from "../../authority/reducer.ts";
import { detailRecord, gateRecord } from "../decision-restore.ts";
import { effectRows } from "../effect-restore.ts";

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
  readonly waits: readonly Row[];
  readonly details: readonly Row[];
  readonly documents: readonly Row[];
  readonly budgets: readonly Row[];
  readonly operations: readonly Row[];
  readonly leases: readonly Row[];
  readonly evidence: readonly Row[];
  readonly stops: readonly Row[];
  readonly completes_adoption?: true;
}

export type Accepted = Extract<CommandResult, { kind: "accepted" }>;

const unchangedEffects = {
  budgets: [],
  operations: [],
  leases: [],
  evidence: [],
  stops: [],
};

export function unchanged(
  state: AuthorityState,
  closed: readonly Row[],
): ChangeDraft {
  return unchangedAt(state.sequence, closed);
}

export function unchangedAt(
  sequence: number,
  closed: readonly Row[],
): ChangeDraft {
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
    waits: [],
    details: [],
    documents: [],
    ...unchangedEffects,
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

function changedEntries<Value>(
  after: Readonly<Record<string, Value>>,
  before: Readonly<Record<string, Value>>,
): Readonly<Record<string, Value>> {
  return Object.fromEntries(
    Object.entries(after).filter(([key, value]) => before[key] !== value),
  );
}

function changed<Value>(
  after: Readonly<Record<string, Value>>,
  before: Readonly<Record<string, Value>>,
): readonly Value[] {
  return Object.values(changedEntries(after, before));
}

function effectDraft(
  result: Accepted,
  before: AuthorityState,
): Pick<
  ChangeDraft,
  "budgets" | "operations" | "leases" | "evidence" | "stops"
> {
  const { effects } = result.state;
  const rows = effectRows(
    {
      budgets: changedEntries(effects.budgets, before.effects.budgets),
      operations: changedEntries(effects.operations, before.effects.operations),
      leases: changedEntries(effects.leases, before.effects.leases),
      stops: changedEntries(effects.stops, before.effects.stops),
      holding: effects.holding,
    },
    result.events.flatMap((event) => evidenceOf(event, result.disposition)),
  );
  return {
    budgets: rows.budgets.map(columns),
    operations: rows.operations.map(columns),
    leases: rows.leases.map(columns),
    evidence: rows.evidence.map(columns),
    stops: rows.stops.map(columns),
  };
}

function eventRecord(event: Accepted["events"][number]): Row {
  return {
    sequence: event.sequence,
    type: event.type,
    run_id: event.runId,
    command_id: event.commandId,
    recorded_at: event.recordedAt,
    request: event.request,
    payload: JSON.stringify(event.payload),
  };
}

export function draft(
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
    ...effectDraft(result, before),
    waits: commandWaitRows(
      changedEntries(state.commandWaits ?? {}, before.commandWaits ?? {}),
    ).map(columns),
    gates: changed(state.gates, before.gates).map((gate) =>
      columns(gateRecord(gate)),
    ),
    details: changed(state.details, before.details).map((details) =>
      columns(detailRecord(details)),
    ),
    previous: before.sequence,
    sequence: state.sequence,
    events: events.map(eventRecord),
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
      created_sequence: state.sequence,
    })),
    released: before.intents
      .filter((intent) => !retained.has(intent.operationId))
      .map((intent) => ({
        operation_id: intent.operationId,
        released_sequence: state.sequence,
      })),
  };
}

type ListName = Exclude<
  keyof ChangeDraft,
  "previous" | "sequence" | "completes_adoption"
>;

export function merged(
  first: ChangeDraft,
  later: readonly ChangeDraft[],
): ChangeDraft {
  const drafts = [first, ...later];
  const joined = (name: ListName): readonly Row[] =>
    drafts.flatMap((draft) => draft[name]);
  return {
    previous: first.previous,
    sequence: later.at(-1)?.sequence ?? first.sequence,
    definitions: joined("definitions"),
    events: joined("events"),
    runs: joined("runs"),
    commands: joined("commands"),
    added: joined("added"),
    released: joined("released"),
    closed: joined("closed"),
    gates: joined("gates"),
    waits: joined("waits"),
    details: joined("details"),
    documents: joined("documents"),
    budgets: joined("budgets"),
    operations: joined("operations"),
    leases: joined("leases"),
    evidence: joined("evidence"),
    stops: joined("stops"),
  };
}
