import { queueStatus, spendNotice } from "./queue-status.ts";
import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { send } from "../cli/client.ts";
import { record, type Fields } from "../protocol.ts";
import { runIdentity } from "../service/submission-handler.ts";
import { queueFailureLimit, type QueuePort } from "../queue-state.ts";
import { readyRefreshes } from "./ticket-source.ts";
import { atGap, workInProgress } from "../work-gap.ts";
import { daemonWorkReads } from "./work-reads.ts";
import { restartHold, startedQueue } from "./restart-marks.ts";
import { queueJournal, type QueueJournal } from "./queue-journal.ts";
import {
  queueControlPort,
  queueStopped,
  type QueueRuntime,
} from "./queue-control.ts";

interface QueueSettings {
  readonly directory: string;
  readonly runtimeDirectory: string;
  readonly intervalMilliseconds: number;
  readonly lanes?: number;
  readonly resetQueue?: boolean;
  readonly readyCommand?: readonly string[];
  readonly workflowId: string;
}

function terminal(run: Fields): boolean {
  return ["completed", "failed", "cancelled"].includes(String(run["state"]));
}

async function runStatus(
  runtimeDirectory: string,
  commandId: string,
): Promise<Fields | undefined> {
  const reply = await send(runtimeDirectory, {
    operation: "status",
    parameters: { runId: runIdentity(commandId) },
  });
  if (reply.kind === "error" && reply.error.code === "unknown-run")
    return undefined;
  if (reply.kind === "error") throw new Error(reply.error.code);
  const run = record(reply.result["run"]);
  if (run === undefined) throw new Error("invalid-run-status");
  return run;
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

async function trackedRuns(
  runtimeDirectory: string,
  commands: readonly string[],
): Promise<readonly { readonly commandId: string; readonly run: Fields }[]> {
  if (commands.length === 0) return [];
  if (commands.length === 1) {
    const commandId = String(commands[0]);
    const run = await runStatus(runtimeDirectory, commandId);
    if (run === undefined) throw new Error("queue-run-missing");
    return [{ commandId, run }];
  }
  const reply = await send(runtimeDirectory, {
    operation: "status",
    parameters: { runIds: commands.map(runIdentity) },
  });
  if (reply.kind === "error") throw new Error(reply.error.code);
  const runs = reply.result["runs"];
  if (!Array.isArray(runs)) throw new Error("invalid-run-list");
  return commands.map((commandId) => {
    const run = runs
      .map(record)
      .find((item) => item?.["runId"] === runIdentity(commandId));
    if (run === undefined) throw new Error("queue-run-missing");
    return { commandId, run };
  });
}

function handedOff(run: Fields): boolean {
  const outcome = record(run["outcome"]);
  return (
    run["state"] === "completed" &&
    outcome?.["kind"] === "handoff_requested" &&
    outcome["issueUpdate"] !== "failed"
  );
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
    ].includes(reply.error.code)
  )
    throw new Error(reply.error.code);
  pending.commands.delete(commandId);
  await pending.save();
}

async function pendingUpdate(directory: string): Promise<string | undefined> {
  return readFile(join(directory, "pending-self-update"), "utf8").catch(
    (error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return undefined;
      throw error;
    },
  );
}

async function holdStarted(
  pending: QueueJournal,
  observed: { readonly mark: string; readonly activeRuns: number },
): Promise<number> {
  const { mark, activeRuns } = observed;
  const timestamp = Number(mark);
  if (!Number.isFinite(timestamp) || timestamp <= 0)
    throw new Error("invalid-pending-self-update");
  if (pending.selfUpdateHold?.mark !== mark || activeRuns > 0) {
    pending.selfUpdateHold = { mark, startedAt: Date.now() };
    await pending.save();
  }
  return pending.selfUpdateHold.startedAt;
}

function updateHold(
  directory: string,
  pending: QueueJournal,
): (activeRuns?: number) => Promise<boolean> {
  let notice: string | undefined;
  return async (activeRuns = 0) => {
    const mark = await pendingUpdate(directory);
    if (mark === undefined && pending.selfUpdateHold !== undefined) {
      pending.selfUpdateHold = undefined;
      await pending.save();
    }
    if (mark === undefined) {
      notice = undefined;
      return false;
    }
    const startedAt = await holdStarted(pending, { mark, activeRuns });
    const holding = activeRuns > 0 || Date.now() - startedAt < 30 * 60 * 1000;
    const line = holding
      ? "Queue holding for pending self-update\n"
      : "Queue continuing after pending self-update time limit\n";
    const key = mark + line;
    if (notice !== key) process.stderr.write(line);
    notice = key;
    return holding;
  };
}

async function admission(
  settings: QueueSettings,
  attempt: {
    readonly pending: QueueJournal;
    readonly holding: () => Promise<boolean>;
    readonly signal: AbortSignal;
  },
): Promise<void> {
  const file = join(settings.directory, "queue-submission");
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
  if (!atGap(await workInProgress(daemonWorkReads(settings)))) return;
  pending.drain = { ...drain, drainedAt: Date.now() };
  await pending.save();
  process.stderr.write("Queue drained\n");
}

interface CycleChecks {
  readonly pending: QueueJournal;
  readonly stop: (pending: QueueJournal) => boolean;
  readonly notice: (status: { readonly holding: boolean }) => boolean;
  readonly update: (activeRuns?: number) => Promise<boolean>;
}

async function admissible(
  settings: QueueSettings,
  checks: CycleChecks,
): Promise<boolean> {
  const { pending, stop } = checks;
  const pendingRuns = stop(pending) ? 0 : await completed(settings, pending);
  if (stop(pending) && pending.drain === undefined) return false;
  await drained(settings, pending);
  const status = await queueStatus(settings);
  if (stop(pending) || pending.drain !== undefined) return false;
  const spend = checks.notice(status);
  const updating = await checks.update(status.busy);
  const lanes = settings.lanes ?? 1;
  if (Math.max(pendingRuns, status.busy) >= lanes || status.busy < pendingRuns)
    return false;
  return !updating && !spend;
}

async function cycle(
  settings: QueueSettings,
  run: { readonly signal: AbortSignal; readonly pending: QueueJournal },
): Promise<void> {
  const { signal, pending } = run;
  await startedQueue(settings, pending);
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
  await rm(join(settings.directory, "queue-submission"), { force: true });
  await recover(settings, pending);
  const stopped = (): boolean => signal.aborted;
  while (!stopped()) {
    await delay(settings.intervalMilliseconds, undefined, { signal }).catch(
      () => undefined,
    );
    if (stopped()) return;
    if (!(await admissible(settings, { pending, stop, notice, update })))
      continue;
    if (stopped()) return;
    await admission(settings, { pending, holding, signal });
  }
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
  };
  const loaded = queueJournal(settings.directory).then((pending) => {
    runtime.pending = pending;
    return pending;
  });
  const running = loaded
    .then((pending) =>
      Promise.all([
        cycle(settings, { signal: runtime.stopping.signal, pending }),
        readyRefreshes(settings.readyCommand, {
          signal: runtime.stopping.signal,
          intervalMilliseconds: settings.intervalMilliseconds,
          listed: (ready) => {
            runtime.ready = ready;
          },
        }),
      ]),
    )
    .catch((error: unknown) => {
      queueStopped(runtime, error);
    });
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
