import type { AuthorityState, RunState, RunStatus } from "./transitions.ts";

export interface WorldRun {
  readonly runId: string;
  readonly receipt: string;
  readonly status: string;
}

export interface Reconciliation {
  readonly commands: readonly Readonly<Record<string, unknown>>[];
  readonly conflicts: readonly string[];
}

const progress: Readonly<
  Partial<Record<RunStatus, Readonly<Record<string, string>>>>
> = {
  queued: {
    running: "mark-started",
    completed: "mark-started",
    failed: "fail-run",
  },
  running: { completed: "complete-run", failed: "fail-run" },
};

export function reconcile(
  state: AuthorityState,
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
  };
}

function next(
  state: AuthorityState,
  observed: { readonly run: RunState; readonly world: WorldRun },
): readonly Readonly<Record<string, unknown>>[] {
  const { run, world } = observed;
  const starting = state.intents.some(
    (intent) => intent.runId === run.runId && intent.kind === "start-run",
  );
  const kind = progress[run.status]?.[world.status];
  if (starting || kind === undefined) return [];
  return [
    {
      kind,
      commandId: `${kind}:${world.receipt}`,
      runId: run.runId,
      expectedRevision: run.revision,
    },
  ];
}
