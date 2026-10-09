import { eligibleIntents } from "./reducer.ts";
import type {
  AuthorityState,
  EffectIntent,
  RunState,
  RunStatus,
} from "./transitions.ts";

export interface WorldRun {
  readonly runId: string;
  readonly receipt: string;
  readonly status: string;
}

export interface Reconciliation {
  readonly send: readonly EffectIntent[];
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
  digest: (operationId: string) => string,
): Reconciliation {
  const observed = Map.groupBy(worldRuns, (world) => world.runId);
  const conflicts = [...observed]
    .filter(([, runs]) => runs.length > 1)
    .map(([runId]) => runId);
  return {
    send: eligibleIntents(state).filter(
      (intent) => intent.kind === "start-run" && !observed.has(intent.runId),
    ),
    commands: Object.values(state.runs).flatMap((run) => {
      const [world, ...others] = observed.get(run.runId) ?? [];
      if (!world || others.length > 0) return [];
      return next(state, run, world, digest);
    }),
    conflicts,
  };
}

function next(
  state: AuthorityState,
  run: RunState,
  world: WorldRun,
  digest: (operationId: string) => string,
): readonly Readonly<Record<string, unknown>>[] {
  const start = state.intents.find(
    (intent) => intent.runId === run.runId && intent.kind === "start-run",
  );
  if (start)
    return [
      {
        kind: "record-dispatch",
        commandId: `dispatch:${digest(start.operationId)}`,
        runId: run.runId,
        operationId: start.operationId,
        receipt: world.receipt,
      },
    ];
  const kind = progress[run.status]?.[world.status];
  if (kind === undefined) return [];
  return [
    {
      kind,
      commandId: `${kind}:${world.receipt}`,
      runId: run.runId,
      expectedRevision: run.revision,
    },
  ];
}
