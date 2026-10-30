import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { readRecord, writeRecord } from "./operation-journal.ts";
import {
  capacityRefusal,
  type TurnEnd,
  type TurnProgress,
} from "./claude-turn.ts";
import {
  attemptCommand,
  attemptUsage,
  attemptCost,
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
  const resume = attempts.options.resume;
  return {
    ...attempts.options.metadata,
    turnStartCommit: attempts.turnStartCommit,
    model: selected.model,
    ...(selected.budgetUsd === undefined
      ? {}
      : { budgetUsd: selected.budgetUsd }),
    ...(selected.fallbackReason === undefined
      ? {}
      : { fallbackReason: selected.fallbackReason }),
    attempt,
    ...(resume !== undefined && attempt === resume.ends.length + 1
      ? { resumedAfter: "daemon-restart" as const }
      : {}),
    startedAt: attempt === 1 ? attempts.startedAt : new Date().toISOString(),
  };
}

export async function prepareAttempt(attempts: Attempts) {
  const selected = attemptCommand(attempts, attempts.ends.length + 1);
  if (selected.budgetUsd === 0) {
    attempts.failure = "claude-turn-budget-exhausted";
    return undefined;
  }
  const entry = attemptEntry(attempts, selected);
  const folder =
    entry.attempt === 1
      ? attempts.start.folder
      : join(attempts.start.folder, `attempt-${String(entry.attempt)}`);
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
  };
}

export function attemptJournal(
  attempts: Attempts,
  entry: ReturnType<typeof attemptEntry>,
) {
  let saved = Promise.resolve();
  let progress: TurnProgress | undefined;
  let processId: number | null = null;
  const save = () => {
    const value = {
      ...entry,
      phase: "running",
      processId,
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
    running: async (identifier: number | null) => {
      processId = identifier;
      await written(attempts.start.folder, {
        name: "started.json",
        value: {
          ...entry,
          startedAt: attempts.startedAt,
          phase: "running",
          processId,
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
  const { start, ends, options } = attempts;
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
      ...options.metadata,
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
      sessionCostUsd: end.result?.costUsd ?? null,
      turns: end.result?.turns ?? null,
    },
  });
}
