import { setTimeout as delay } from "node:timers/promises";
import {
  reconcile,
  type WorldReport,
  type WorldRun,
} from "../authority/reconciliation.ts";
import type { AuthorityState } from "../authority/transitions.ts";

export type ReconciledState = Pick<
  AuthorityState,
  "runs" | "intents" | "details" | "gates" | "commands"
>;

export interface ReconciliationPorts {
  readonly state: () => Promise<ReconciledState>;
  readonly submit: (command: Readonly<Record<string, unknown>>) => Promise<{
    readonly kind: "accepted" | "duplicate" | "rejected" | "failed";
  }>;
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
  const read = await ports.outcome(world.receipt).then(
    (outcome) => ({ outcome }),
    () => undefined,
  );
  if (read === undefined) return { ...world, status: "unreadable" };
  return read.outcome === undefined
    ? world
    : { ...world, outcome: read.outcome };
}

export async function reconcileWorld(
  ports: ReconciliationPorts,
): Promise<Pass> {
  const listed = await ports.runs();
  const state = await ports.state();
  const runs: WorldRun[] = [];
  for (const world of listed)
    runs.push(await withOutcome(ports, { state, world }));
  const { commands, reports, conflicts } = reconcile(state, runs);
  const sent: string[] = [];
  for (const command of commands) {
    const receipt = await ports.submit(command);
    sent.push(`${String(command["commandId"])} ${receipt.kind}`);
    if (receipt.kind === "failed")
      return { sent, interrupted: true, reports, conflicts };
  }
  return { sent, interrupted: false, reports, conflicts };
}

export type LoopReport =
  | WorldReport
  | { readonly kind: "world-run-conflict"; readonly runId: string }
  | { readonly kind: "world-reconciliation-failed"; readonly passes: number };

export const passFailureLimit = 3;

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
  let failures = 0;
  const cycle = async (): Promise<void> => {
    while (!stopping.signal.aborted) {
      const pass = await reconcileWorld(parts).catch(() => undefined);
      reports = pass === undefined ? reports : reported(pass);
      failures = pass?.interrupted === false ? 0 : failures + 1;
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
    reports: () =>
      failures < passFailureLimit
        ? reports
        : [
            ...reports,
            { kind: "world-reconciliation-failed", passes: failures },
          ],
  };
}
