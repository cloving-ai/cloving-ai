import { setTimeout as delay } from "node:timers/promises";
import {
  startTurn,
  type RunningTurn,
  type TurnEnd,
  type TurnStart,
} from "./claude-turn.ts";
import { turnHead, retryEvidence, indexFailure } from "./retry-worktree.ts";
import { writeRecord } from "./operation-journal.ts";
import {
  attemptCommand,
  combined,
  kindOf,
  type Attempts,
  type RetryOptions,
} from "./turn-attempts.ts";
import {
  prepareAttempt,
  attemptJournal,
  recordedEnd,
} from "./turn-attempt-journal.ts";
export type { RetrySettings } from "./turn-attempts.ts";

const waits = { capacity: [60_000, 180_000], network: [600_000, 2_400_000] };
const networkContinuation =
  "An earlier attempt stopped because the network was not available. Continue from the current state of the work tree. Check each earlier commit, push, review comment and message. Do not repeat a write that is done. Stop and report a write whose result is not known.";
const continuation =
  "An earlier attempt stopped because the model was at capacity; continue from the current state of the work tree.\n\n";

function written(
  folder: string,
  entry: { readonly name: string; readonly value: unknown },
): Promise<void> {
  return writeRecord(folder, { ...entry, permissions: "private" });
}

function controlled(attempts: Attempts, start: TurnStart): RunningTurn {
  const turn = startTurn(start);
  const stop = () => {
    turn.stop(attempts.grace.milliseconds);
  };
  attempts.stopping.signal.addEventListener("abort", stop, { once: true });
  return {
    ...turn,
    ended: turn.ended.finally(() => {
      attempts.stopping.signal.removeEventListener("abort", stop);
    }),
  };
}

async function promptOf(attempts: Attempts): Promise<string> {
  const { start, ends, stopping, turnStartCommit } = attempts;
  if (ends.length === 0) return start.prompt;
  if (!ends.some((end) => kindOf(attempts, end) === "network"))
    return continuation + start.prompt;
  const evidence = await retryEvidence(
    { directory: start.directory, signal: stopping.signal },
    turnStartCommit,
  );
  return `${networkContinuation}\n\nCommits since the start of this turn:\n${evidence}\n\n${start.prompt}`;
}

async function launched(
  attempts: Attempts,
  prompt = attempts.start.prompt,
): Promise<RunningTurn | undefined> {
  const prepared = await prepareAttempt(attempts);
  if (prepared === undefined || attempts.stopping.signal.aborted)
    return undefined;
  const { start, options } = attempts;
  const { entry, selected, folder } = prepared;
  const journal = attemptJournal(attempts, entry);
  const turn = controlled(attempts, {
    ...start,
    command:
      entry.resumedAfter === undefined
        ? selected.command
        : resumeCommand(selected.command, options.resume?.sessionId ?? ""),
    progress: journal.progress,
    folder,
    ...(entry.attempt === 1 ? {} : { activityFolder: start.folder }),
    prompt,
  });
  try {
    await journal.running(turn.processId);
    return {
      ...turn,
      ended: turn.ended.then((end) => ({
        ...end,
        ...(entry.resumedAfter === undefined
          ? {}
          : { resumedAfter: entry.resumedAfter }),
      })),
    };
  } catch (error) {
    turn.stop(0);
    await turn.ended;
    throw error;
  }
}

function resumeCommand(
  command: readonly string[],
  sessionId: string,
): readonly string[] {
  const separator = command.indexOf("--");
  const boundary = separator < 0 ? command.length : separator;
  return [
    ...command.slice(0, boundary),
    "--resume",
    sessionId,
    ...command.slice(boundary),
  ];
}

async function waited(attempts: Attempts, milliseconds: number): Promise<void> {
  const { start, options, stopping, ends } = attempts;
  await written(start.folder, {
    name: "started.json",
    value: {
      ...options.metadata,
      turnStartCommit: attempts.turnStartCommit,
      startedAt: attempts.startedAt,
      attempt: ends.length,
      phase: "waiting",
      processId: null,
      waitMilliseconds: milliseconds,
      waitingAt: new Date().toISOString(),
    },
  });
  const wait =
    options.retryDelay ??
    ((duration, signal) => delay(duration, undefined, { signal }));
  await wait(milliseconds, stopping.signal).catch((error: unknown) => {
    if (!stopping.signal.aborted) throw error;
  });
}

async function preparedRetry(attempts: Attempts): Promise<string | TurnEnd> {
  const prompt = await promptOf(attempts);
  const failure = await indexFailure({
    directory: attempts.start.directory,
    signal: attempts.stopping.signal,
  });
  if (cancelled(attempts)) return { ...combined(attempts), stopped: true };
  if (failure !== null) {
    await written(attempts.start.folder, {
      name: "retry-failure.json",
      value: failure,
    });
    return {
      ...combined(attempts),
      reason: failure.reason,
      detail: `${failure.fix}${failure.lockPath === undefined ? "" : ` Lock: ${failure.lockPath}`}`,
    };
  }
  return prompt;
}

async function finished(
  attempts: Attempts,
  first: RunningTurn,
): Promise<TurnEnd> {
  const { ends } = attempts;
  let turn: RunningTurn | undefined = first;
  while (turn !== undefined) {
    const end = await turn.ended;
    ends.push(end);
    await recordedEnd(attempts, { processId: turn.processId, end });
    const milliseconds = retryWait(attempts, end);
    if (cancelled(attempts) || milliseconds === undefined) break;
    await waited(attempts, milliseconds);
    if (cancelled(attempts)) return { ...combined(attempts), stopped: true };
    const prepared = await preparedRetry(attempts);
    if (typeof prepared !== "string") return prepared;
    turn = await launched(attempts, prepared);
  }
  return attemptOutcome(attempts);
}

function retryWait(attempts: Attempts, end: TurnEnd): number | undefined {
  const kind = kindOf(attempts, end);
  if (kind === null) return undefined;
  if (attemptCommand(attempts, attempts.ends.length + 1).budgetUsd === 0) {
    attempts.failure = "claude-turn-budget-exhausted";
    return undefined;
  }
  return waits[kind][
    attempts.ends.filter((end) => end.resumedAfter === undefined).length - 1
  ];
}

function attemptOutcome(attempts: Attempts): TurnEnd {
  return {
    ...combined(attempts),
    ...(attempts.failure === undefined ? {} : { reason: attempts.failure }),
    ...(cancelled(attempts) ? { stopped: true } : {}),
  };
}

function cancelled(attempts: Attempts): boolean {
  return attempts.stopping.signal.aborted;
}

export async function startRetriedTurn(
  start: TurnStart,
  options: RetryOptions,
): Promise<RunningTurn> {
  const stopping = options.stopping ?? new AbortController();
  const turnStartCommit =
    options.resume === undefined
      ? await turnHead({
          directory: start.directory,
          signal: stopping.signal,
        })
      : options.resume.turnStartCommit;
  const attempts: Attempts = {
    turnStartCommit,
    start,
    startedAt: options.resume?.startedAt ?? new Date().toISOString(),
    options,
    stopping,
    ends: [...(options.resume?.ends ?? [])],
    grace: { milliseconds: options.stopMilliseconds ?? 15_000 },
  };
  const turn = await launched(attempts);
  if (turn === undefined)
    return {
      processId: null,
      ended: Promise.resolve(attemptOutcome(attempts)),
      stop: () => {
        stopping.abort();
      },
    };
  return {
    processId: turn.processId,
    ended: finished(attempts, turn),
    stop: (graceMilliseconds) => {
      attempts.grace.milliseconds = graceMilliseconds;
      attempts.stopping.abort();
    },
  };
}
