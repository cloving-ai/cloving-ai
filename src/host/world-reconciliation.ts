import { setTimeout as delay } from "node:timers/promises";
import {
  reconcile,
  type WorldReport,
  type WorldRun,
} from "../authority/reconciliation.ts";
import type { AuthorityState } from "../authority/transitions.ts";

export type ReconciledState = Pick<
  AuthorityState,
  "runs" | "intents" | "details"
>;

export interface ReconciliationPorts {
  readonly state: () => Promise<ReconciledState>;
  readonly submit: (
    command: Readonly<Record<string, unknown>>,
  ) => Promise<{ readonly kind: string }>;
  readonly runs: () => Promise<readonly WorldRun[]>;
  readonly outcome: (receipt: string) => Promise<string | undefined>;
}

export interface Pass {
  readonly sent: readonly string[];
  readonly interrupted: boolean;
  readonly reports: readonly WorldReport[];
  readonly conflicts: readonly string[];
}

async function withOutcome(
  ports: ReconciliationPorts,
  observed: { readonly state: ReconciledState; readonly world: WorldRun },
): Promise<WorldRun> {
  const { state, world } = observed;
  const ended =
    world.status === "completed" &&
    state.runs[world.runId]?.status === "running";
  if (!ended) return world;
  const outcome = await ports.outcome(world.receipt);
  return outcome === undefined ? world : { ...world, outcome };
}

export async function reconcileWorld(
  ports: ReconciliationPorts,
): Promise<Pass> {
  const state = await ports.state();
  const listed = await ports.runs();
  const runs: WorldRun[] = [];
  for (const world of listed)
    runs.push(await withOutcome(ports, { state, world }));
  const plan = reconcile(state, runs);
  const sent: string[] = [];
  for (const command of plan.commands) {
    const receipt = await ports.submit(command);
    sent.push(`${String(command["commandId"])} ${receipt.kind}`);
    if (receipt.kind === "storage-failure")
      return { sent, interrupted: true, reports: [], conflicts: [] };
  }
  return {
    sent,
    interrupted: false,
    reports: plan.reports,
    conflicts: plan.conflicts,
  };
}

export type LoopReport =
  WorldReport | { readonly kind: "world-run-conflict"; readonly runId: string };

export interface WorldLoop {
  readonly stop: () => Promise<void>;
  readonly reports: () => readonly LoopReport[];
}

function reported(pass: Pass): readonly LoopReport[] {
  return [
    ...pass.reports,
    ...pass.conflicts.map((runId) => ({
      kind: "world-run-conflict" as const,
      runId,
    })),
  ];
}

export function worldLoop(
  parts: ReconciliationPorts & { readonly intervalMilliseconds: number },
): WorldLoop {
  const stopping = new AbortController();
  let reports: readonly LoopReport[] = [];
  const cycle = async (): Promise<void> => {
    while (!stopping.signal.aborted) {
      const pass = await reconcileWorld(parts).catch(() => undefined);
      reports = pass === undefined ? reports : reported(pass);
      await delay(parts.intervalMilliseconds, undefined, {
        signal: stopping.signal,
      }).catch(() => undefined);
    }
  };
  const running = cycle();
  return {
    stop: async () => {
      stopping.abort();
      await running;
    },
    reports: () => reports,
  };
}
