import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { mkdir } from "node:fs/promises";
import { readRecord, writeRecord } from "./operation-journal.ts";
import type { ResumeReason } from "../worker-usage.ts";
import {
  capacityRefusal,
  type TurnEnd,
  type TurnProgress,
} from "./claude-turn.ts";
import type { TurnLaunch } from "../turn-launch.ts";
import { preparedPiSession } from "./pi-resume.ts";
import { piSessionCommandFailure } from "./pi-session.ts";
import {
  attemptCommand,
  attemptUsage,
  attemptCost,
  attemptMetadata,
  type AttemptEntry,
  type Attempts,
} from "./turn-attempts.ts";

function written(
  folder: string,
  entry: { readonly name: string; readonly value: unknown },
): Promise<void> {
  return writeRecord(folder, { ...entry, permissions: "private" });
}

function attemptEntry(
  attempts: Attempts,
  selected: ReturnType<typeof attemptCommand>,
) {
  const attempt = attempts.ends.length + 1;
  return {
    ...attemptMetadata(attempts),
    turnStartCommit: attempts.turnStartCommit,
    model: selected.model,
    ...(selected.budgetUsd === undefined
      ? {}
      : { budgetUsd: selected.budgetUsd }),
    ...(selected.fallbackReason === undefined
      ? {}
      : { fallbackReason: selected.fallbackReason }),
    attempt,
    ...resumedAfter(attempts, attempt),
    startedAt: attempt === 1 ? attempts.startedAt : new Date().toISOString(),
  };
}

function resumedAfter(
  attempts: Attempts,
  attempt: number,
): { readonly resumedAfter?: ResumeReason } {
  const resume = attempts.options.resume;
  if (attempts.steering.pending !== undefined) return { resumedAfter: "steer" };
  if (resume === undefined || attempt !== resume.ends.length + 1) return {};
  return { resumedAfter: "daemon-restart" };
}

export async function prepareAttempt(attempts: Attempts) {
  const selected = attemptCommand(attempts, attempts.ends.length + 1);
  const nativePi =
    attempts.start.worker === "pi" && attempts.start.output !== "text";
  const failure = nativePi
    ? piSessionCommandFailure(selected.command)
    : undefined;
  if (failure !== undefined) {
    attempts.failure = failure;
    return undefined;
  }
  if (selected.budgetUsd === 0) {
    attempts.failure = "claude-turn-budget-exhausted";
    return undefined;
  }
  const planned = attemptEntry(attempts, selected);
  const folder =
    planned.attempt === 1
      ? attempts.start.folder
      : join(attempts.start.folder, `attempt-${String(planned.attempt)}`);
  const piSession = nativePi
    ? await preparedPiSession({
        folder,
        directory: attempts.start.directory,
        previous: attempts.options.resume?.piSession,
      })
    : undefined;
  if (typeof piSession === "string") {
    attempts.failure = piSession;
    return undefined;
  }
  const entry = {
    ...planned,
    ...(piSession === undefined ? {} : { piSession }),
  };
  await written(attempts.start.folder, {
    name: "started.json",
    value: {
      ...entry,
      startedAt: attempts.startedAt,
      phase: "starting",
      processId: null,
    },
  });
  await mkdir(folder, { recursive: true, mode: 0o700 });
  return { entry, selected, folder };
}

function progressFields(
  attempts: Attempts,
  progress: TurnProgress | undefined,
) {
  const result = progress?.result;
  const end = { exitCode: null, result };
  if (result === undefined)
    return {
      sessionId: progress?.sessionId ?? null,
      sessionCostUsd: null,
      costUsd: null,
    };
  return {
    sessionId: progress?.sessionId ?? null,
    sessionCostUsd: result.costUsd,
    costUsd: attemptCost([...attempts.ends, end], attempts.ends.length),
    usage: result.usage,
    turns: result.turns,
    ...piFields(attempts.start.worker, result),
  };
}

export function attemptJournal(attempts: Attempts, entry: AttemptEntry) {
  let saved = Promise.resolve();
  let progress: TurnProgress | undefined;
  let processId: number | null = null;
  let launch: TurnLaunch | null = null;
  const save = () => {
    const value = {
      ...entry,
      ...attemptMetadata(attempts),
      phase: "running",
      processId,
      ...(launch === null ? {} : { launch }),
      ...progressFields(attempts, progress),
    };
    saved = saved.then(() =>
      written(attempts.start.folder, {
        name: `attempt-${String(entry.attempt)}.json`,
        value,
      }),
    );
    return saved;
  };
  return {
    progress: (snapshot: TurnProgress) => {
      progress = snapshot;
      return save();
    },
    running: async (started: {
      readonly processId: number | null;
      readonly launch: TurnLaunch | null;
    }) => {
      processId = started.processId;
      launch = started.launch;
      await written(attempts.start.folder, {
        name: "started.json",
        value: {
          ...entry,
          ...attemptMetadata(attempts),
          startedAt: attempts.startedAt,
          phase: "running",
          processId,
          ...(launch === null ? {} : { launch }),
        },
      });
      await save();
    },
  };
}

export async function recordedEnd(
  attempts: Attempts,
  completion: { readonly processId: number | null; readonly end: TurnEnd },
): Promise<void> {
  const { start, ends } = attempts;
  const { processId, end } = completion;
  const attempt = ends.length;
  const selected = attemptCommand(attempts, attempt);
  const name = `attempt-${String(attempt)}.json`;
  const record = await readRecord(start.folder, name);
  const started = typeof record === "object" && record !== null ? record : {};
  const startedAt: unknown = Reflect.get(started, "startedAt");
  if (typeof startedAt !== "string")
    throw new Error("attempt-start-time-missing");
  await written(start.folder, {
    name,
    value: {
      ...started,
      ...attemptMetadata(attempts),
      turnStartCommit: attempts.turnStartCommit,
      ...attemptUsage(attempts, { end, attempt }),
      ...(selected.fallbackReason === undefined
        ? {}
        : { fallbackReason: selected.fallbackReason }),
      attempt,
      processId,
      startedAt,
      endedAt: new Date().toISOString(),
      exitCode: end.exitCode,
      capacity: capacityRefusal(end.result),
      ...piFields(start.worker, end.result),
      sessionCostUsd: end.result?.costUsd ?? null,
      turns: end.result?.turns ?? null,
    },
  });
}

export async function waited(
  attempts: Attempts,
  milliseconds: number,
): Promise<void> {
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

function piFields(worker: string | undefined, result: TurnEnd["result"]) {
  return worker === "pi"
    ? {
        pricingModel: result?.pricingModel ?? null,
        piAccounting: result?.piAccounting,
      }
    : {};
}
