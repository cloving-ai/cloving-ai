import {
  commandWaitKey,
  type CommandWaitState,
  type CommandWaitsState,
} from "./command-waits.ts";
import type { CommandWaits } from "../workflow-declaration.ts";

export interface CommandWaitView<Time = string> {
  readonly name: string;
  readonly command: string;
  readonly state: string;
  readonly maximumWaitSeconds: number;
  readonly startedAt: Time | null;
  readonly deadline: Time | null;
  readonly nextCheckAt: Time | null;
  readonly checkCount: number;
  readonly remainingSeconds: number;
  readonly reason: string | null;
}

export function commandWaitView(
  wait: CommandWaitState,
  now: number,
): CommandWaitView<number> {
  return {
    name: wait.name,
    command: wait.command,
    state: wait.state,
    maximumWaitSeconds: wait.maximumWaitSeconds,
    startedAt: wait.startedAt,
    deadline: wait.deadline,
    nextCheckAt: wait.nextCheckAt,
    checkCount: wait.checkCount,
    remainingSeconds: Math.max(
      0,
      Math.ceil((wait.deadline - (wait.settledAt ?? now)) / 1000),
    ),
    reason: wait.reason,
  };
}

export function commandWaitViews(input: {
  readonly runId: string;
  readonly declarations: CommandWaits;
  readonly waits: CommandWaitsState;
  readonly now: number;
}): readonly CommandWaitView<number>[] {
  return Object.entries(input.declarations).map(([name, declaration]) => {
    const wait = input.waits[commandWaitKey(input.runId, name)];
    return wait === undefined
      ? {
          name,
          command: declaration.command,
          state: "not-started",
          maximumWaitSeconds: declaration.maximumWaitSeconds,
          startedAt: null,
          deadline: null,
          nextCheckAt: null,
          checkCount: 0,
          remainingSeconds: declaration.maximumWaitSeconds,
          reason: null,
        }
      : commandWaitView(wait, input.now);
  });
}
