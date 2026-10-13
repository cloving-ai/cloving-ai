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

export interface WorldReport {
  readonly kind: "unknown-world-run";
  readonly runId: string;
  readonly receipt: string;
}

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

type Reconciled = Pick<AuthorityState, "runs" | "intents" | "details">;

export function reconcile(
  state: Reconciled,
  worldRuns: readonly WorldRun[],
): Reconciliation {
  const observed = Map.groupBy(worldRuns, (world) => world.runId);
  const conflicts = [...observed]
    .filter(([, runs]) => conflicting(runs))
    .map(([runId]) => runId);
  return {
    commands: Object.values(state.runs).flatMap((run) => {
      const segments = (observed.get(run.runId) ?? []).toSorted(
        (first, second) => (created(first) < created(second) ? -1 : 1),
      );
      const world = segments.at(-1);
      if (!world || conflicting(segments)) return [];
      return next(state, { run, world, segments });
    }),
    conflicts,
    reports: worldRuns
      .filter((world) => !Object.hasOwn(state.runs, world.runId))
      .map((world) => ({
        kind: "unknown-world-run",
        runId: world.runId,
        receipt: world.receipt,
      })),
  };
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

function next(
  state: Reconciled,
  observed: Observed & { readonly segments: readonly WorldRun[] },
): readonly Readonly<Record<string, unknown>>[] {
  const { run, world, segments } = observed;
  const pending = state.intents.some(
    (intent) =>
      intent.runId === run.runId && intent.kind !== "protected-effect",
  );
  if (pending || terminal.includes(run.status)) return [];
  const failed = segments.find((segment) =>
    Object.hasOwn(endings, segment.status),
  );
  if (failed) return ended(state, { run, world: failed });
  const kind = progress[run.status]?.[world.status];
  const waiting =
    kind === "complete-run" && world.outcome === "waiting_for_decision";
  if (kind === undefined || waiting) return [];
  return [moved(kind, observed)];
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

function ended(
  state: Reconciled,
  observed: Observed,
): readonly Readonly<Record<string, unknown>>[] {
  const { run, world } = observed;
  const reason = endings[world.status];
  const evidence = `world-run:${world.receipt}`;
  const last = state.details[run.runId]?.observation;
  const recorded = last?.reason === reason && last?.evidence === evidence;
  const observation = {
    kind: "report-observation",
    commandId: `observe:${String(reason)}:${world.receipt}`,
    runId: run.runId,
    condition: "infrastructure-failure",
    reason,
    evidence,
  };
  return [
    ...(recorded ? [] : [observation]),
    ...(run.status === "paused" ? [] : [moved("fail-run", observed)]),
  ];
}
