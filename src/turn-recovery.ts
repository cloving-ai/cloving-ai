import type { Fields } from "./protocol.ts";

export type RecoveryWay = "connected" | "resumed" | "command";

export interface TurnRecovery {
  readonly runId: string;
  readonly way: RecoveryWay;
}

export interface TurnRecoveries {
  readonly note: (recovery: TurnRecovery) => void;
  readonly finish: () => void;
  readonly fields: () => Fields;
}

export function turnRecoveries(): TurnRecoveries {
  const runs: Readonly<Record<RecoveryWay, Set<string>>> = {
    connected: new Set(),
    resumed: new Set(),
    command: new Set(),
  };
  let state: "recovering" | "done" = "recovering";
  return {
    note: (recovery) => {
      runs[recovery.way].add(recovery.runId);
    },
    finish: () => {
      state = "done";
    },
    fields: () => ({
      state,
      connected: [...runs.connected].toSorted(),
      resumed: [...runs.resumed].toSorted(),
      commands: [...runs.command].toSorted(),
    }),
  };
}
