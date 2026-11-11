import { startTurn, type RunningTurn, type TurnStart } from "./claude-turn.ts";
import type { Attempts } from "./turn-attempts.ts";
import { keepTurn, ownTurn } from "./turn-owners.ts";
import { stopLeftProcesses } from "./worktree-processes.ts";

async function leftProcesses(attempts: Attempts, since: number): Promise<void> {
  await stopLeftProcesses({
    directory: attempts.start.directory,
    seconds: Math.ceil((Date.now() - since) / 1000) + 2,
    signal: new AbortController().signal,
    stopMilliseconds: attempts.grace.milliseconds,
    log: attempts.options.log,
    runId: attempts.options.runId,
  }).catch(() => undefined);
}

export function controlledTurn(
  attempts: Attempts,
  launch: { readonly start: TurnStart; readonly since: number },
): RunningTurn {
  const turn = startTurn(launch.start);
  const owned =
    turn.processId === null
      ? undefined
      : ownTurn(launch.start.directory, {
          runId: attempts.options.runId,
          processId: turn.processId,
        });
  const stop = () => {
    turn.stop(attempts.grace.milliseconds);
  };
  attempts.stopping.signal.addEventListener("abort", stop, { once: true });
  const cleaned = turn.exited.then(async (exit) => {
    if (exit === "released")
      keepTurn(launch.start.directory, {
        runId: attempts.options.runId,
        launch: await turn.launch,
      });
    owned?.();
    if (exit !== "released") await leftProcesses(attempts, launch.since);
  });
  return {
    ...turn,
    ended: turn.ended
      .finally(() => cleaned)
      .finally(() => {
        attempts.stopping.signal.removeEventListener("abort", stop);
      }),
  };
}
