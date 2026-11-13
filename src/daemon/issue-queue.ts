import type { QueueSource } from "../queue-settings.ts";
import {
  queueStatus,
  runStatus,
  trackedRuns,
  spendNotice,
} from "./queue-status.ts";
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { send } from "../cli/client.ts";
import { record, type Fields } from "../protocol.ts";
import { runIdentity } from "../service/submission-handler.ts";
import { queueFailureLimit, type QueuePort } from "../queue-state.ts";
import { readyRefreshes } from "./ticket-source.ts";
import { atGap, workInProgress } from "../work-gap.ts";
import { daemonWorkReads } from "../cli/work-reads.ts";
import { restartHold, startedQueue } from "./restart-marks.ts";
import { queueJournal, type QueueJournal } from "./queue-journal.ts";
import { updateHold } from "./queue-update-hold.ts";
import { clearContinuedFailures, handedOff } from "./queue-continuations.ts";
import { roomGate, type RoomGate } from "./queue-room-gate.ts";
import { holdRecord, type HoldRecord } from "./queue-holds.ts";
import { waitingRuns } from "./working-runs.ts";
import { hostSignals } from "./host-signals.ts";
import type { HostSignals, QueueLimits } from "../queue-room.ts";
import type { Permit } from "../cli/workspace-permit.ts";
import {
  queueControlPort,
  queueStopped,
  type QueueRuntime,
} from "./queue-control.ts";

interface QueueSettings {
  readonly directory: string;
  readonly runtimeDirectory: string;
  readonly queueDirectory?: string;
  readonly intervalMilliseconds: number;
  readonly intervalSource?: QueueSource;
  readonly limits?: () => QueueLimits;
  readonly writeLanes?: (lanes: number) => Promise<void>;
  readonly resetQueue?: boolean;
  readonly resumeQueue?: boolean;
  readonly readyCommand?: readonly string[];
  readonly workflowId: string;
  readonly signals?: () => Promise<HostSignals>;
  readonly permit?: () => Promise<Permit>;
}

function limitsOf(settings: QueueSettings): QueueLimits {
  return settings.limits?.() ?? { lanes: 1, workingLanes: 1 };
}

function terminal(run: Fields): boolean {
  return ["completed", "failed", "cancelled"].includes(String(run["state"]));
}

async function recover(
  settings: QueueSettings,
  pending: QueueJournal,
): Promise<void> {
  for (const commandId of pending.commands) {
    if (await runStatus(settings.runtimeDirectory, commandId)) continue;
    pending.commands.delete(commandId);
    await pending.save();
  }
}

function limited(pending: QueueJournal): boolean {
  return pending.failures.length >= queueFailureLimit;
}

function stopNotice(): (pending: QueueJournal) => boolean {
  let noticed = false;
  return (pending) => {
    const stopped = limited(pending);
    if (stopped && !noticed)
      process.stderr.write(
        `Queue stopped: 3 runs in a row ended without handoff: ${pending.failures.join(", ")}\n`,
      );
    noticed = stopped;
    return stopped;
  };
}

async function retired(
  pending: QueueJournal,
  ending: { readonly commandId: string; readonly run: Fields },
): Promise<void> {
  const { commandId, run } = ending;
  pending.commands.delete(commandId);
  if (handedOff(run)) pending.failures.length = 0;
  else pending.failures.push(runIdentity(commandId));
  await pending.save();
  if (handedOff(run) || limited(pending)) return;
  const outcome = record(run["outcome"]);
  process.stderr.write(
    `Queue run ended ${String(outcome?.["kind"] ?? run["state"])}${outcome?.["issueUpdate"] === "failed" ? "; issueUpdate: failed" : ""}: ${runIdentity(commandId)}; continuing\n`,
  );
}

async function completed(
  settings: QueueSettings,
  pending: QueueJournal,
): Promise<number> {
  let pendingRuns = 0;
  const endings: { readonly commandId: string; readonly run: Fields }[] = [];
  const tracked = [...pending.commands].filter(
    (commandId) => commandId !== pending.retryCommandId,
  );
  for (const { commandId, run } of await trackedRuns(
    settings.runtimeDirectory,
    tracked,
  )) {
    if (terminal(run)) endings.push({ commandId, run });
    else pendingRuns += 1;
  }
  endings.sort(
    (first, second) =>
      Number(
        first.run["terminalSequence"] ?? first.run["latestSequence"] ?? 0,
      ) -
      Number(
        second.run["terminalSequence"] ?? second.run["latestSequence"] ?? 0,
      ),
  );
  for (const ending of endings)
    if (!limited(pending)) await retired(pending, ending);
  return pendingRuns;
}

async function submit(
  settings: QueueSettings,
  pending: QueueJournal,
): Promise<void> {
  const commandId = pending.retryCommandId ?? randomUUID();
  pending.commands.add(commandId);
  await pending.save();
  const reply = await send(settings.runtimeDirectory, {
    operation: "run",
    parameters: {
      workflowId: settings.workflowId,
      source: "ticket",
      submission: { ticket: "next" },
      commandId,
    },
  });
  pending.retryCommandId = undefined;
  if (reply.kind === "result") return;
  if (
    [
      "resolver-timeout",
      "next-ticket-not-available",
      "ticket-not-available",
    ].includes(reply.error.code)
  ) {
    pending.retryCommandId = commandId;
    process.stderr.write(
      `Queue ${reply.error.code}: command ${commandId}; will retry\n`,
    );
    return;
  }
  if (
    ![
      "no-ready-ticket",
      "workflow-active",
      "ticket-active",
      "ticket-dependency-open",
      "queue-spend-limit",
      "queue-repository-full",
    ].includes(reply.error.code)
  )
    throw new Error(reply.error.code);
  pending.commands.delete(commandId);
  await pending.save();
}

async function admission(
  settings: QueueSettings,
  attempt: {
    readonly pending: QueueJournal;
    readonly holding: () => Promise<boolean>;
    readonly signal: AbortSignal;
  },
): Promise<void> {
  const file = join(
    settings.queueDirectory ?? settings.directory,
    "queue-submission",
  );
  await writeFile(file, "", { mode: 0o600 });
  try {
    if (
      !(await attempt.holding()) &&
      !attempt.signal.aborted &&
      attempt.pending.drain === undefined
    )
      await submit(settings, attempt.pending);
  } finally {
    await rm(file, { force: true });
  }
}

async function drained(
  settings: QueueSettings,
  pending: QueueJournal,
): Promise<void> {
  const { drain } = pending;
  if (drain === undefined || drain.drainedAt !== null) return;
  if (
    settings.queueDirectory === undefined &&
    !atGap(await workInProgress(daemonWorkReads(settings)))
  )
    return;
  if (
    settings.queueDirectory !== undefined &&
    (await queueStatus(settings)).busy > 0
  )
    return;
  pending.drain = { ...drain, drainedAt: Date.now() };
  await pending.save();
  process.stderr.write("Queue drained\n");
}

interface CycleChecks {
  readonly pending: QueueJournal;
  readonly stop: (pending: QueueJournal) => boolean;
  readonly notice: (status: { readonly holding: boolean }) => boolean;
  readonly update: (activeRuns?: number) => Promise<boolean>;
  readonly room: RoomGate;
}

async function admissible(
  settings: QueueSettings,
  checks: CycleChecks,
): Promise<boolean> {
  const { pending, stop } = checks;
  await clearContinuedFailures(settings.runtimeDirectory, pending);
  const pendingRuns = stop(pending) ? 0 : await completed(settings, pending);
  if (stop(pending) && pending.drain === undefined) return checks.room.clear();
  await drained(settings, pending);
  const status = await queueStatus(settings);
  if (stop(pending) || pending.drain !== undefined) return checks.room.clear();
  const spend = checks.notice(status);
  const updating = await checks.update(status.busy);
  const { lanes } = limitsOf(settings);
  const full =
    Math.max(pendingRuns, status.busy) >= lanes || status.busy < pendingRuns;
  return full || updating || spend
    ? checks.room.clear()
    : checks.room.open(status.busy);
}

async function cycle(
  settings: QueueSettings,
  run: {
    readonly signal: AbortSignal;
    readonly pending: QueueJournal;
    readonly room: RoomGate;
    readonly runtime: QueueRuntime;
  },
): Promise<void> {
  const { signal, pending, room } = run;
  const selfUpdate = updateHold(settings.directory, pending);
  const restart = restartHold(settings.directory);
  const update = async (activeRuns = 0) => {
    const restarting = await restart();
    return (await selfUpdate(activeRuns)) || restarting;
  };
  const notice = spendNotice();
  const stop = stopNotice();
  const holding = async (activeRuns = 0) => {
    const updating = await update(activeRuns);
    const spend = notice(await queueStatus(settings));
    return updating || spend;
  };
  await recover(settings, pending);
  const stopped = (): boolean => signal.aborted;
  const checks = { pending, stop, notice, update, room };
  while (!stopped()) {
    run.runtime.nextCheckAt = new Date(
      Date.now() + settings.intervalMilliseconds,
    ).toISOString();
    await delay(settings.intervalMilliseconds, undefined, { signal }).catch(
      () => undefined,
    );
    if (stopped()) return;
    try {
      if (!(await admissible(settings, checks))) continue;
      if (stopped()) return;
      await admission(settings, { pending, holding, signal });
    } finally {
      room.release();
    }
  }
}

function queueRoom(
  settings: QueueSettings,
  parts: { readonly runtime: QueueRuntime; readonly holds: HoldRecord },
): RoomGate {
  return roomGate(
    {
      limits: () => limitsOf(settings),
      signals: settings.signals ?? hostSignals(),
      waiting: () => waitingRuns(settings),
      repositoryBusy: async () => (await queueStatus(settings)).repositoryBusy,
      ...(settings.permit === undefined ? {} : { permit: settings.permit }),
    },
    async (hold) => {
      parts.runtime.hold = hold;
      await parts.holds.note(hold);
    },
  );
}

async function loadedQueue(settings: QueueSettings, runtime: QueueRuntime) {
  const directory = settings.queueDirectory ?? settings.directory;
  const pending = await queueJournal(directory);
  const holds = await holdRecord(directory);
  await startedQueue(settings, pending);
  await rm(join(directory, "queue-submission"), { force: true });
  runtime.pending = pending;
  runtime.holds = holds;
  return { pending, holds };
}

export function issueQueue(settings: QueueSettings): {
  readonly stop: () => Promise<void>;
  readonly port: QueuePort;
  readonly ready: Promise<void>;
} {
  const runtime: QueueRuntime = {
    pending: undefined,
    error: undefined,
    stopping: new AbortController(),
    limits: () => limitsOf(settings),
    ...(settings.writeLanes === undefined
      ? {}
      : { writeLanes: settings.writeLanes }),
    interval: {
      value: settings.intervalMilliseconds / 1000,
      source: settings.intervalSource ?? "default",
    },
  };
  const loaded = loadedQueue(settings, runtime);
  const running = loaded
    .then(({ pending, holds }) =>
      Promise.all([
        cycle(settings, {
          signal: runtime.stopping.signal,
          runtime,
          pending,
          room: queueRoom(settings, { runtime, holds }),
        }).finally(holds.close),
        readyRefreshes(settings.readyCommand, {
          signal: runtime.stopping.signal,
          intervalMilliseconds: settings.intervalMilliseconds,
          listed: (ready) => {
            runtime.ready = ready;
          },
        }),
      ]),
    )
    .catch((error: unknown) => queueStopped(runtime, error));
  return {
    stop: async () => {
      runtime.stopping.abort();
      await running;
    },
    port: queueControlPort(runtime),
    ready: loaded.then(
      () => undefined,
      () => undefined,
    ),
  };
}
