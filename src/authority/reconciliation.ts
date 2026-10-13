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
    .filter(([, runs]) => runs.length > 1)
    .map(([runId]) => runId);
  return {
    commands: Object.values(state.runs).flatMap((run) => {
      const [world, ...others] = observed.get(run.runId) ?? [];
      if (!world || others.length > 0) return [];
      return next(state, { run, world });
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

interface Observed {
  readonly run: RunState;
  readonly world: WorldRun;
}

function next(
  state: Reconciled,
  observed: Observed,
): readonly Readonly<Record<string, unknown>>[] {
  const { run, world } = observed;
  const starting = state.intents.some(
    (intent) => intent.runId === run.runId && intent.kind === "start-run",
  );
  if (starting || terminal.includes(run.status)) return [];
  if (Object.hasOwn(endings, world.status)) return ended(state, observed);
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
