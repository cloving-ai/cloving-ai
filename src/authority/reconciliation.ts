import { gateContinuation } from "./gate-reduction.ts";
import { continues } from "./gates.ts";
import { startOperation } from "./reduction.ts";
import {
  terminal,
  type AuthorityState,
  type RunState,
  type RunStatus,
} from "./transitions.ts";

export interface WorldRun {
  readonly runId: string;
  readonly receipt: string;
  readonly status: string;
  readonly outcome?: string;
  readonly operationId?: string | null;
  readonly createdAt?: string;
}

export type WorldReport =
  | {
      readonly kind: "unknown-world-run" | "world-run-unreadable";
      readonly runId: string;
      readonly receipt: string;
    }
  | {
      readonly kind: "world-run-absent";
      readonly runId: string;
      readonly operationId: string;
    };

export interface Reconciliation {
  readonly commands: readonly Readonly<Record<string, unknown>>[];
  readonly conflicts: readonly string[];
  readonly reports: readonly WorldReport[];
}

const progress: Readonly<
  Partial<Record<RunStatus, Readonly<Record<string, string>>>>
> = {
  queued: { running: "mark-started", completed: "mark-started" },
  running: { completed: "complete-run" },
};

const endings: Readonly<Record<string, string>> = {
  failed: "world-run-failed",
  cancelled: "world-run-cancelled",
};

type Reconciled = Pick<
  AuthorityState,
  "runs" | "intents" | "details" | "gates" | "commands"
>;

interface Segments {
  readonly run: RunState;
  readonly segments: readonly WorldRun[];
}

export function reconcile(
  state: Reconciled,
  worldRuns: readonly WorldRun[],
): Reconciliation {
  const observed = Map.groupBy(worldRuns, (world) => world.runId);
  const known = Object.values(state.runs).map((run) => ({
    run,
    segments: (observed.get(run.runId) ?? []).toSorted((first, second) =>
      created(first) < created(second) ? -1 : 1,
    ),
  }));
  return {
    commands: known.flatMap((found) => planned(state, found)),
    conflicts: known
      .filter((found) => conflicting(found.segments))
      .map((found) => found.run.runId),
    reports: [
      ...worldRuns.flatMap((world) => unusable(state, world)),
      ...known.flatMap((found) => absent(state, found)),
    ],
  };
}

function unusable(state: Reconciled, world: WorldRun): readonly WorldReport[] {
  const { runId, receipt } = world;
  if (!Object.hasOwn(state.runs, runId))
    return [{ kind: "unknown-world-run", runId, receipt }];
  if (world.status !== "unreadable") return [];
  return [{ kind: "world-run-unreadable", runId, receipt }];
}

function dispatched(state: Reconciled, run: RunState): readonly string[] {
  const pending = state.intents.map((intent) => intent.operationId);
  const continued = Object.values(state.gates)
    .filter((gate) => gate.runId === run.runId)
    .filter(continues)
    .map((gate) => gateContinuation(gate).operationId);
  return [startOperation(run.runId), ...continued].filter(
    (operationId) => !pending.includes(operationId),
  );
}

function missing(state: Reconciled, found: Segments): readonly string[] {
  const { run, segments } = found;
  const tags = segments.map((world) => world.operationId ?? null);
  if (terminal.includes(run.status) || tags.includes(null)) return [];
  return dispatched(state, run).filter(
    (operationId) => !tags.includes(operationId),
  );
}

function absent(state: Reconciled, found: Segments): readonly WorldReport[] {
  return missing(state, found).map((operationId) => ({
    kind: "world-run-absent",
    runId: found.run.runId,
    operationId,
  }));
}

function created(world: WorldRun): string {
  return `${world.createdAt ?? ""} ${world.receipt}`;
}

function conflicting(runs: readonly WorldRun[]): boolean {
  const operations = runs.map((world) => world.operationId ?? null);
  return (
    runs.length > 1 &&
    (operations.includes(null) || new Set(operations).size < runs.length)
  );
}

interface Observed {
  readonly run: RunState;
  readonly world: WorldRun;
}

function planned(
  state: Reconciled,
  found: Segments,
): readonly Readonly<Record<string, unknown>>[] {
  const { run, segments } = found;
  const world = segments.at(-1);
  if (!world || terminal.includes(run.status)) return [];
  if (conflicting(segments)) return unsent(state, conflict(found));
  const pending = state.intents.some(
    (intent) =>
      intent.runId === run.runId && intent.kind !== "protected-effect",
  );
  if (pending) return [];
  const failed = segments.find((segment) =>
    Object.hasOwn(endings, segment.status),
  );
  if (failed)
    return ended(state, {
      run,
      world: failed,
      reason: String(endings[failed.status]),
    });
  return next(state, { ...found, world });
}

function next(
  state: Reconciled,
  observed: Observed & Segments,
): readonly Readonly<Record<string, unknown>>[] {
  const { run, world } = observed;
  const kind = progress[run.status]?.[world.status];
  if (kind === undefined) return [];
  const waits =
    kind === "complete-run" && world.outcome === "waiting_for_decision";
  if (!waits) return [moved(kind, observed)];
  const held = run.gates.length > 0 || missing(state, observed).length > 0;
  if (held) return [];
  return ended(state, { run, world, reason: "world-run-waits-without-gate" });
}

function moved(
  kind: string,
  observed: Observed,
): Readonly<Record<string, unknown>> {
  const { run, world } = observed;
  return {
    kind,
    commandId: `${kind}:${world.receipt}`,
    runId: run.runId,
    expectedRevision: run.revision,
  };
}

function noted(
  observed: Observed & { readonly reason: string },
  evidence: string,
): Readonly<Record<string, unknown>> {
  const { run, world, reason } = observed;
  return {
    kind: "report-observation",
    commandId: `observe:${reason}:${world.receipt}`,
    runId: run.runId,
    condition: "infrastructure-failure",
    reason,
    evidence,
  };
}

function unsent(
  state: Reconciled,
  command: Readonly<Record<string, unknown>>,
): readonly Readonly<Record<string, unknown>>[] {
  const recorded = Object.hasOwn(state.commands, String(command["commandId"]));
  return recorded ? [] : [command];
}

function conflict(found: Segments): Readonly<Record<string, unknown>> {
  const [world = { runId: "", receipt: "", status: "" }] = found.segments;
  return noted(
    { run: found.run, world, reason: "world-run-conflict" },
    found.segments
      .slice(0, 2)
      .map((segment) => `world-run:${segment.receipt}`)
      .join("/"),
  );
}

function ended(
  state: Reconciled,
  observed: Observed & { readonly reason: string },
): readonly Readonly<Record<string, unknown>>[] {
  const { run, world } = observed;
  return [
    ...unsent(state, noted(observed, `world-run:${world.receipt}`)),
    ...(run.status === "paused" ? [] : [moved("fail-run", observed)]),
  ];
}
