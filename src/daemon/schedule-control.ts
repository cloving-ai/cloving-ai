import type { Fields, Reply } from "../protocol.ts";
import type { SchedulePort, ScheduleProgress } from "../schedule-progress.ts";
import { scheduleStops } from "../schedule-progress.ts";
import { runIdentity } from "../service/submission-handler.ts";
import { failed, invalidRequest, result } from "../service/replies.ts";
import type { DeclaredWorkflow } from "../workflow-declaration.ts";
import type { scheduleJournal } from "./schedule-journal.ts";

type Journal = Awaited<ReturnType<typeof scheduleJournal>>;

interface ScheduleState {
  readonly journal: Journal;
  readonly declarations: readonly DeclaredWorkflow[];
  readonly clock: () => number;
  readonly recoverPending: (entry: {
    readonly workflowId: string;
    readonly progress: ScheduleProgress;
  }) => Promise<ScheduleProgress>;
}

function summary(workflowId: string, progress: ScheduleProgress): Fields {
  return {
    workflowId,
    everySeconds: progress.everySeconds,
    state: progress.state,
    failuresInRow: progress.failuresInRow,
    failedRunIds: progress.failedRunIds,
    lastSlot: progress.lastSlot,
    nextAt: progress.state === "active" ? progress.nextAt : null,
    activeRunId:
      progress.activeCommandId === undefined
        ? null
        : runIdentity(progress.activeCommandId),
    stoppedAt: progress.stoppedAt ?? null,
    stoppedSlot: progress.stoppedSlot ?? null,
    stops: scheduleStops(progress),
  };
}

export function scheduleConnection(): {
  readonly request: SchedulePort;
  readonly connect: (port: SchedulePort) => void;
} {
  let port: SchedulePort | undefined;
  return {
    request: (parameters) =>
      port?.(parameters) ??
      Promise.resolve(failed("schedules-unavailable", {})),
    connect: (connected) => {
      port = connected;
    },
  };
}

async function change(
  settings: ScheduleState,
  command: {
    readonly workflowId: string;
    readonly action: "pause" | "resume";
    readonly now: number;
  },
): Promise<Reply> {
  const { workflowId, action, now } = command;
  const { journal } = settings;
  let prior = journal.entries.get(workflowId);
  if (prior === undefined) return failed("unknown-schedule", { workflowId });
  const state = action === "pause" ? "paused" : "active";
  if (prior.state === state)
    return result("schedule", { schedule: summary(workflowId, prior) });
  if (prior.pending !== undefined) {
    prior = await settings.recoverPending({ workflowId, progress: prior });
    journal.entries.set(workflowId, prior);
    await journal.save();
  }
  const rest = { ...prior };
  delete rest.stoppedAt;
  delete rest.stoppedSlot;
  const progress: ScheduleProgress =
    action === "pause"
      ? { ...prior, state, stops: scheduleStops(prior) }
      : {
          ...rest,
          state,
          failuresInRow: 0,
          failedRunIds: [],
          stops: scheduleStops(prior),
          nextAt: now + prior.everySeconds * 1000,
        };
  journal.entries.set(workflowId, progress);
  try {
    await journal.save();
  } catch (error) {
    journal.entries.set(workflowId, prior);
    throw error;
  }
  return result("schedule", { schedule: summary(workflowId, progress) });
}

function request(settings: ScheduleState, parameters: Fields): Promise<Reply> {
  const { action, workflowId } = parameters;
  const scheduled = settings.declarations.filter(
    (entry) => entry.schedule !== undefined,
  );
  if (action === "list")
    return Promise.resolve(
      result("schedules", {
        schedules: scheduled.flatMap((entry) => {
          const progress = settings.journal.entries.get(entry.workflowId);
          return progress === undefined
            ? []
            : [summary(entry.workflowId, progress)];
        }),
      }),
    );
  if (
    (action !== "pause" && action !== "resume") ||
    typeof workflowId !== "string"
  )
    return Promise.resolve(
      invalidRequest("Use list, pause or resume with a workflow ID."),
    );
  if (!scheduled.some((entry) => entry.workflowId === workflowId))
    return Promise.resolve(failed("unknown-schedule", { workflowId }));
  return change(settings, {
    workflowId,
    action,
    now: settings.clock(),
  });
}

export function scheduleControl(
  settings: ScheduleState & {
    readonly signal: AbortSignal;
    readonly tick: () => Promise<void>;
  },
): {
  readonly request: SchedulePort;
  readonly tick: () => Promise<void>;
  readonly drain: () => Promise<void>;
} {
  let running = Promise.resolve();
  const serialized = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = running.then(async () => {
      settings.signal.throwIfAborted();
      return operation();
    });
    running = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
  return {
    request: (parameters) =>
      serialized(() => request(settings, parameters)).catch(() =>
        failed("schedules-unavailable", {}),
      ),
    tick: () => serialized(settings.tick),
    drain: () => running,
  };
}
