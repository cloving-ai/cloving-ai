import { setTimeout as delay } from "node:timers/promises";
import {
  startTurn,
  type RunningTurn,
  type TurnEnd,
  type TurnStart,
} from "./claude-turn.ts";
import { turnHead, retryEvidence, indexFailure } from "./retry-worktree.ts";
import { readRecord, writeRecord } from "./operation-journal.ts";
import { resumeWorktree } from "./resume-worktree.ts";
import { stopLeftProcesses } from "./worktree-processes.ts";
import { ownTurn } from "./turn-owners.ts";
import { readResume, resumedCommand, resumePrompt } from "./claude-recovery.ts";
import {
  attemptCommand,
  attemptMetadata,
  combined,
  kindOf,
  type Attempts,
  type RetryOptions,
} from "./turn-attempts.ts";
import {
  queued,
  steer,
  steeredPrompt,
  steeringOf,
  steerPrompt,
  type SteerNote,
  type SteerOutcome,
} from "./turn-steering.ts";
import {
  prepareAttempt,
  attemptJournal,
  recordedEnd,
} from "./turn-attempt-journal.ts";
export type { RetrySettings } from "./turn-attempts.ts";

export interface RetriedTurn extends RunningTurn {
  readonly steer: (note: SteerNote) => SteerOutcome;
}

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

async function leftProcesses(
  attempts: Attempts,
  startedAt: number,
): Promise<void> {
  await stopLeftProcesses({
    directory: attempts.start.directory,
    seconds: Math.ceil((performance.now() - startedAt) / 1000) + 2,
    signal: new AbortController().signal,
    stopMilliseconds: attempts.grace.milliseconds,
    log: attempts.options.log,
    runId: attempts.options.runId,
  }).catch(() => undefined);
}

function controlled(attempts: Attempts, start: TurnStart): RunningTurn {
  const startedAt = performance.now();
  const turn = startTurn(start);
  const owned =
    turn.processId === null
      ? undefined
      : ownTurn(start.directory, {
          runId: attempts.options.runId,
          processId: turn.processId,
        });
  const stop = () => {
    turn.stop(attempts.grace.milliseconds);
  };
  attempts.stopping.signal.addEventListener("abort", stop, { once: true });
  const cleaned = turn.exited.then(() => {
    owned?.();
    return leftProcesses(attempts, startedAt);
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

async function promptOf(attempts: Attempts): Promise<string> {
  const { start, ends, stopping, turnStartCommit } = attempts;
  const prompt = steeredPrompt(start.prompt, attempts.steering);
  if (ends.length === 0) return prompt;
  if (!ends.some((end) => kindOf(attempts, end) === "network"))
    return continuation + prompt;
  const evidence = await retryEvidence(
    { directory: start.directory, signal: stopping.signal },
    turnStartCommit,
  );
  return `${networkContinuation}\n\nCommits since the start of this turn:\n${evidence}\n\n${prompt}`;
}

interface Launch {
  readonly entry: { readonly resumedAfter?: string };
  readonly selected: { readonly command: readonly string[] };
  readonly steered: Attempts["steering"]["pending"];
}

function launchCommand(attempts: Attempts, launch: Launch): readonly string[] {
  const { entry, selected, steered } = launch;
  if (entry.resumedAfter === undefined) return selected.command;
  return (
    resumedCommand({
      worker: attempts.start.worker,
      command: selected.command,
      sessionId: steered?.sessionId ?? attempts.options.resume?.sessionId ?? "",
    }) ?? selected.command
  );
}

function launchPrompt(launch: Launch, prompt: string): string {
  if (launch.steered !== undefined) return steerPrompt(launch.steered.notes);
  return launch.entry.resumedAfter === undefined ? prompt : resumePrompt;
}

async function launched(
  attempts: Attempts,
  prompt = attempts.start.prompt,
): Promise<RunningTurn | undefined> {
  const prepared = await prepareAttempt(attempts);
  const { steering } = attempts;
  const steered = steering.pending;
  delete steering.pending;
  if (prepared === undefined || attempts.stopping.signal.aborted)
    return undefined;
  const { start } = attempts;
  const { entry, folder } = prepared;
  const journal = attemptJournal(attempts, entry);
  const launch = { ...prepared, steered };
  const turn = controlled(attempts, {
    ...start,
    command: launchCommand(attempts, launch),
    progress: (progress) => {
      if (steering.child !== undefined)
        steering.child.sessionId = progress.sessionId;
      return journal.progress(progress);
    },
    folder,
    ...(entry.attempt === 1
      ? {}
      : { laterAttempt: { folder: start.folder, attempt: entry.attempt } }),
    prompt: launchPrompt(launch, prompt),
  });
  steering.child = { turn, sessionId: null };
  if (steered !== undefined && turn.processId !== null)
    steering.delivered.push(...steered.notes);
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

async function waited(attempts: Attempts, milliseconds: number): Promise<void> {
  const { start, options, stopping, ends } = attempts;
  await written(start.folder, {
    name: "started.json",
    value: {
      ...attemptMetadata(attempts),
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
    delete attempts.steering.child;
    ends.push(end);
    await recordedEnd(attempts, { processId: turn.processId, end });
    if (!cancelled(attempts) && attempts.steering.pending !== undefined)
      return steeredChild(attempts);
    if (interruptedChild(attempts, { processId: turn.processId, end }))
      return resumedChild(attempts);
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

function interruptedChild(
  attempts: Attempts,
  completion: { readonly processId: number | null; readonly end: TurnEnd },
): boolean {
  const { start } = attempts;
  const { processId, end } = completion;
  return (
    !cancelled(attempts) &&
    (start.worker ?? "claude") === "claude" &&
    start.output !== "text" &&
    processId !== null &&
    end.exitCode !== 0 &&
    end.result === undefined &&
    end.reason === undefined
  );
}

async function resumedChild(attempts: Attempts): Promise<TurnEnd> {
  const locked = await resumeWorktree({
    directory: attempts.start.directory,
    folder: attempts.start.folder,
    signal: attempts.stopping.signal,
    stopMilliseconds: attempts.grace.milliseconds,
    log: attempts.options.log,
  });
  if (locked !== null) return { ...combined(attempts), reason: locked.reason };
  const started = await readRecord(attempts.start.folder, "started.json");
  const resume = await readResume(attempts.start.folder, started);
  if (resume === undefined)
    return { ...combined(attempts), reason: "claude-turn-interrupted" };
  const prepared = await preparedRetry(attempts);
  if (typeof prepared !== "string") return prepared;
  const recovered: Attempts = {
    ...attempts,
    options: { ...attempts.options, resume },
    ends: [...resume.ends],
  };
  const turn = await launched(recovered);
  return turn === undefined
    ? attemptOutcome(recovered)
    : finished(recovered, turn);
}

async function steeredChild(attempts: Attempts): Promise<TurnEnd> {
  const turn = await launched(attempts);
  return turn === undefined
    ? attemptOutcome(attempts)
    : finished(attempts, turn);
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

function resumable(start: TurnStart): boolean {
  return (
    start.output !== "text" &&
    resumedCommand({
      worker: start.worker,
      command: start.command,
      sessionId: "session",
    }) !== undefined
  );
}

export async function startRetriedTurn(
  start: TurnStart,
  options: RetryOptions,
): Promise<RetriedTurn> {
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
    steering: steeringOf(options.resume),
  };
  const turn = await launched(attempts);
  if (turn === undefined)
    return {
      processId: null,
      ended: Promise.resolve(attemptOutcome(attempts)),
      stop: () => {
        stopping.abort();
      },
      steer: () => queued("no-open-turn"),
    };
  return {
    processId: turn.processId,
    ended: finished(attempts, turn),
    steer: (note) =>
      resumable(start)
        ? steer(attempts.steering, {
            note,
            grace: attempts.grace.milliseconds,
          })
        : queued("harness-cannot-resume"),
    stop: (graceMilliseconds) => {
      attempts.grace.milliseconds = graceMilliseconds;
      attempts.stopping.abort();
    },
  };
}
