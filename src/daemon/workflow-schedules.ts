import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { mutate } from "../cli/client.ts";
import {
  record,
  type Fields,
  type Reply,
  type ServiceRequest,
} from "../protocol.ts";
import type { WorkerPort } from "../service/worker-port.ts";
import { runIdentity } from "../service/submission-handler.ts";
import type { DeclaredWorkflow } from "../workflow-declaration.ts";
import { configuredSchedules } from "../workflow-schedule.ts";
import { declaredInput } from "./declared-input.ts";
import { finishedScheduleRun } from "../schedule-progress.ts";
import { scheduleControl } from "./schedule-control.ts";
import type { SchedulePort } from "../schedule-progress.ts";
import {
  scheduleJournal,
  type ScheduleProgress,
  type PendingSlot,
} from "./schedule-journal.ts";

interface ScheduleSettings {
  readonly directory: string;
  readonly runtimeDirectory: string;
  readonly declarations?: readonly DeclaredWorkflow[];
  readonly scheduleClock?: () => number;
  readonly submit: WorkerPort["submit"];
}

interface ScheduleContext extends ScheduleSettings {
  readonly signal: AbortSignal;
  readonly nextObservations: Map<string, number>;
}

type Journal = Awaited<ReturnType<typeof scheduleJournal>>;

export function scheduledDeclarations(
  settings: {
    readonly declarations?: readonly DeclaredWorkflow[];
    readonly schedules?: unknown;
  },
  limits?: { readonly repository: string; readonly documentBytes: number },
):
  | {
      readonly kind: "configured";
      readonly declarations: readonly DeclaredWorkflow[];
    }
  | {
      readonly kind: "refused";
      readonly reason: string;
      readonly detail: string;
    } {
  try {
    const declarations = settings.declarations ?? [];
    const configured = configuredSchedules(
      declarations,
      settings.schedules === undefined ? {} : settings.schedules,
    );
    if (
      limits !== undefined &&
      Object.entries(configured).some(
        ([workflowId, schedule]) =>
          Buffer.byteLength(
            JSON.stringify(
              declaredInput(limits.repository, {
                commandId: commandId(workflowId, 1),
                submission: schedule.input,
              }),
            ),
          ) > limits.documentBytes,
      )
    )
      throw new Error("invalid-schedule-input");
    return {
      kind: "configured",
      declarations: declarations.map((entry) => {
        const schedule = Object.hasOwn(configured, entry.workflowId)
          ? configured[entry.workflowId]
          : undefined;
        return schedule === undefined ? entry : { ...entry, schedule };
      }),
    };
  } catch (error) {
    return {
      kind: "refused",
      reason: "schedule-rejected",
      detail: String(error),
    };
  }
}

function commandId(workflowId: string, slot: number): string {
  return `schedule:${workflowId}:${String(slot)}`;
}

async function request(
  settings: ScheduleContext,
  request: ServiceRequest,
): Promise<Reply> {
  const interrupted = Promise.withResolvers<undefined>();
  const interrupt = (): void => {
    interrupted.resolve(undefined);
  };
  settings.signal.addEventListener("abort", interrupt, { once: true });
  try {
    settings.signal.throwIfAborted();
    return await mutate(settings.runtimeDirectory, {
      request,
      signal: interrupted.promise,
    });
  } finally {
    settings.signal.removeEventListener("abort", interrupt);
  }
}

async function pending(
  settings: ScheduleContext,
  entry: { readonly workflowId: string; readonly progress: ScheduleProgress },
): Promise<ScheduleProgress> {
  settings.signal.throwIfAborted();
  const { workflowId, progress } = entry;
  const { pending: planned, ...rest } = progress;
  if (planned === undefined) return progress;
  if (progress.state !== "active") throw new Error("invalid-schedule-state");
  const identity = commandId(workflowId, progress.lastSlot);
  if (planned.kind === "skip") {
    const receipt = await settings.submit({
      kind: "record-schedule-skip",
      commandId: `skip:${identity}`,
      runId: planned.runId,
      workflowId,
      slot: progress.lastSlot,
    });
    if (receipt.kind !== "accepted" && receipt.kind !== "duplicate")
      throw new Error("schedule-skip-not-recorded");
    return rest;
  }
  const reply = await request(settings, {
    operation: "run",
    parameters: {
      workflowId,
      source: "declared",
      submission: planned.input,
      commandId: identity,
    },
  });
  if (reply.kind === "error") throw new Error(reply.error.code);
  return { ...rest, activeCommandId: identity };
}

async function scheduledRunStatus(
  settings: ScheduleContext,
  runId: string,
): Promise<Fields> {
  const reply = await request(settings, {
    operation: "status",
    parameters: { runId },
  });
  if (reply.kind === "error") throw new Error(reply.error.code);
  const run = record(reply.result["run"]);
  if (typeof run?.["state"] !== "string")
    throw new Error("invalid-schedule-run");
  return run;
}

async function active(
  settings: ScheduleContext,
  progress: ScheduleProgress,
): Promise<ScheduleProgress> {
  if (progress.activeCommandId === undefined) return progress;
  const now = (settings.scheduleClock ?? Date.now)();
  const next = settings.nextObservations.get(progress.activeCommandId) ?? 0;
  const due = progress.state === "active" && now >= progress.nextAt;
  if (!due && now < next) return progress;
  const runId = runIdentity(progress.activeCommandId);
  const run = await scheduledRunStatus(settings, runId);
  settings.nextObservations.set(progress.activeCommandId, now + 5000);
  if (run["condition"] === "cancelling") return progress;
  if (!["completed", "failed", "cancelled"].includes(String(run["state"])))
    return progress;
  settings.nextObservations.delete(progress.activeCommandId);
  return finishedScheduleRun(progress, {
    runId,
    status: run,
    now: (settings.scheduleClock ?? Date.now)(),
  });
}

async function advance(
  settings: ScheduleContext & {
    readonly journal: Journal;
    readonly now: number;
  },
  declaration: DeclaredWorkflow,
): Promise<void> {
  settings.signal.throwIfAborted();
  const { workflowId, schedule } = declaration;
  if (schedule === undefined) return;
  let progress = settings.journal.entries.get(workflowId);
  if (progress === undefined) throw new Error("missing-schedule-state");
  if (progress.pending !== undefined) {
    progress = await pending(settings, { workflowId, progress });
    settings.journal.entries.set(workflowId, progress);
    await settings.journal.save();
    if (settings.now < progress.nextAt) return;
  }
  const observed = await active(settings, progress);
  if (observed !== progress) {
    progress = observed;
    settings.journal.entries.set(workflowId, progress);
    await settings.journal.save();
  }
  if (progress.state !== "active" || settings.now < progress.nextAt) return;
  const runId =
    progress.activeCommandId === undefined
      ? undefined
      : runIdentity(progress.activeCommandId);
  const planned: PendingSlot =
    runId === undefined
      ? { kind: "run", input: schedule.input }
      : { kind: "skip", runId };
  const elapsed =
    Math.floor(
      (settings.now - progress.nextAt) / (schedule.everySeconds * 1000),
    ) + 1;
  progress = {
    ...progress,
    lastSlot: progress.lastSlot + elapsed,
    nextAt: progress.nextAt + elapsed * schedule.everySeconds * 1000,
    pending: planned,
  };
  settings.journal.entries.set(workflowId, progress);
  await settings.journal.save();
  settings.journal.entries.set(
    workflowId,
    await pending(settings, { workflowId, progress }),
  );
  await settings.journal.save();
}

async function tick(
  settings: ScheduleContext,
  journal: Journal,
): Promise<void> {
  const now = (settings.scheduleClock ?? Date.now)();
  for (const declaration of settings.declarations ?? [])
    await advance({ ...settings, journal, now }, declaration);
}

async function initialized(settings: ScheduleSettings): Promise<Journal> {
  const journal = await scheduleJournal(join(settings.directory, "state"));
  const now = (settings.scheduleClock ?? Date.now)();
  for (const declaration of settings.declarations ?? []) {
    const { workflowId, schedule } = declaration;
    if (schedule === undefined) continue;
    const prior = journal.entries.get(workflowId);
    if (prior?.everySeconds === schedule.everySeconds) continue;
    journal.entries.set(workflowId, {
      ...(prior ?? {
        lastSlot: 0,
        state: "active",
        failuresInRow: 0,
        failedRunIds: [],
      }),
      everySeconds: schedule.everySeconds,
      nextAt: now + schedule.everySeconds * 1000,
    });
  }
  if (settings.declarations?.some((entry) => entry.schedule !== undefined))
    await journal.save();
  return journal;
}

export async function workflowSchedules(settings: ScheduleSettings): Promise<{
  readonly stop: () => Promise<void>;
  readonly request: SchedulePort;
}> {
  const declarations = settings.declarations ?? [];
  const journal = await initialized(settings);
  const stopping = new AbortController();
  const stopped = (): boolean => stopping.signal.aborted;
  const context = {
    ...settings,
    signal: stopping.signal,
    nextObservations: new Map<string, number>(),
  };
  const control = scheduleControl({
    journal,
    declarations,
    clock: settings.scheduleClock ?? Date.now,
    signal: stopping.signal,
    recoverPending: (entry) => pending(context, entry),
    tick: () => tick(context, journal),
  });
  const running = (async () => {
    while (!stopped()) {
      await delay(250, undefined, { signal: stopping.signal }).catch(
        () => undefined,
      );
      if (stopped()) return;
      await control.tick();
    }
  })().catch((error: unknown) => {
    if (!stopped())
      process.stderr.write(`Schedules stopped: ${String(error)}\n`);
    stopping.abort();
  });
  return {
    request: control.request,
    stop: async () => {
      stopping.abort();
      await running;
      await control.drain();
    },
  };
}
