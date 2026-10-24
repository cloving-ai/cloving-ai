import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { send } from "../cli/client.ts";
import { record } from "../protocol.ts";
import type { WorkerPort } from "../service/worker-port.ts";
import { runIdentity } from "../service/submission-handler.ts";
import type { DeclaredWorkflow } from "../workflow-declaration.ts";
import { configuredSchedules } from "../workflow-schedule.ts";
import { declaredInput } from "./ticket-registration.ts";
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

async function pending(
  settings: ScheduleSettings,
  entry: { readonly workflowId: string; readonly progress: ScheduleProgress },
): Promise<ScheduleProgress> {
  const { workflowId, progress } = entry;
  const { pending: planned, ...rest } = progress;
  if (planned === undefined) return progress;
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
  const reply = await send(settings.runtimeDirectory, {
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

async function active(
  settings: ScheduleSettings,
  progress: ScheduleProgress,
): Promise<string | undefined> {
  if (progress.activeCommandId === undefined) return undefined;
  const runId = runIdentity(progress.activeCommandId);
  const reply = await send(settings.runtimeDirectory, {
    operation: "status",
    parameters: { runId },
  });
  if (reply.kind === "error") throw new Error(reply.error.code);
  const run = record(reply.result["run"]);
  if (typeof run?.["state"] !== "string")
    throw new Error("invalid-schedule-run");
  return ["completed", "failed", "cancelled"].includes(run["state"])
    ? undefined
    : runId;
}

async function tick(
  settings: ScheduleSettings,
  journal: Journal,
): Promise<void> {
  const now = (settings.scheduleClock ?? Date.now)();
  for (const declaration of settings.declarations ?? []) {
    const { workflowId, schedule } = declaration;
    if (schedule === undefined) continue;
    let progress = journal.entries.get(workflowId);
    if (progress === undefined) throw new Error("missing-schedule-state");
    if (progress.pending !== undefined) {
      progress = await pending(settings, { workflowId, progress });
      journal.entries.set(workflowId, progress);
      await journal.save();
    }
    if (now < progress.nextAt) continue;
    const runId = await active(settings, progress);
    const planned: PendingSlot =
      runId === undefined
        ? { kind: "run", input: schedule.input }
        : { kind: "skip", runId };
    const elapsed =
      Math.floor((now - progress.nextAt) / (schedule.everySeconds * 1000)) + 1;
    progress = {
      ...progress,
      lastSlot: progress.lastSlot + elapsed,
      nextAt: progress.nextAt + elapsed * schedule.everySeconds * 1000,
      pending: planned,
    };
    journal.entries.set(workflowId, progress);
    await journal.save();
    journal.entries.set(
      workflowId,
      await pending(settings, { workflowId, progress }),
    );
    await journal.save();
  }
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
      ...prior,
      everySeconds: schedule.everySeconds,
      lastSlot: prior?.lastSlot ?? 0,
      nextAt: now + schedule.everySeconds * 1000,
    });
  }
  await journal.save();
  return journal;
}

export async function workflowSchedules(settings: ScheduleSettings): Promise<{
  readonly stop: () => Promise<void>;
}> {
  if (
    !(settings.declarations ?? []).some((entry) => entry.schedule !== undefined)
  )
    return { stop: () => Promise.resolve() };
  const journal = await initialized(settings);
  const stopping = new AbortController();
  const stopped = (): boolean => stopping.signal.aborted;
  const running = (async () => {
    while (!stopped()) {
      await delay(250, undefined, { signal: stopping.signal }).catch(
        () => undefined,
      );
      if (stopped()) return;
      await tick(settings, journal);
    }
  })().catch((error: unknown) => {
    process.stderr.write(`Schedules stopped: ${String(error)}\n`);
  });
  return {
    stop: async () => {
      stopping.abort();
      await running;
    },
  };
}
