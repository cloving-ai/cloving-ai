import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { send } from "../cli/client.ts";
import { record, type Fields } from "../protocol.ts";
import { runIdentity } from "../service/submission-handler.ts";

interface QueueSettings {
  readonly directory: string;
  readonly runtimeDirectory: string;
  readonly intervalMilliseconds: number;
}

interface QueueJournal {
  readonly commands: Set<string>;
  readonly failures: string[];
  readonly save: () => Promise<void>;
  retryCommandId: string | undefined;
}

function identifiers(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((id) => typeof id === "string" && id.length > 0)
  )
    throw new Error("invalid-queue-commands");
  return value.map(String);
}

async function journal(directory: string): Promise<QueueJournal> {
  const file = join(directory, "queue-commands.json");
  const text = await readFile(file, "utf8").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return "[]";
    throw error;
  });
  const value: unknown = JSON.parse(text);
  const saved = record(value);
  const commands = new Set(
    identifiers(Array.isArray(value) ? value : saved?.["commands"]),
  );
  const failures = Array.isArray(value) ? [] : identifiers(saved?.["failures"]);
  if (failures.length > 3) throw new Error("invalid-queue-commands");
  return {
    commands,
    failures,
    retryCommandId: undefined,
    save: async () => {
      await writeFile(
        `${file}.tmp`,
        JSON.stringify({ commands: [...commands], failures }) + "\n",
        { mode: 0o600, flush: true },
      );
      await rename(`${file}.tmp`, file);
    },
  };
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

function handedOff(run: Fields): boolean {
  const outcome = record(run["outcome"]);
  return (
    run["state"] === "completed" &&
    outcome?.["kind"] === "handoff_requested" &&
    outcome["issueUpdate"] !== "failed"
  );
}

class QueueFailureLimit extends Error {}

function checkFailureLimit(pending: QueueJournal): void {
  if (pending.failures.length >= 3)
    throw new QueueFailureLimit(
      `3 runs in a row ended without handoff: ${pending.failures.join(", ")}`,
    );
}

async function completed(
  settings: QueueSettings,
  pending: QueueJournal,
): Promise<boolean> {
  checkFailureLimit(pending);
  let pendingRun = false;
  const tracked = [...pending.commands].filter(
    (commandId) => commandId !== pending.retryCommandId,
  );
  for (const commandId of tracked) {
    const run = await runStatus(settings.runtimeDirectory, commandId);
    if (run === undefined) throw new Error("queue-run-missing");
    if (!terminal(run)) {
      pendingRun = true;
      continue;
    }
    pending.commands.delete(commandId);
    if (handedOff(run)) pending.failures.length = 0;
    else pending.failures.push(runIdentity(commandId));
    await pending.save();
    checkFailureLimit(pending);
    if (!handedOff(run)) {
      const outcome = record(run["outcome"]);
      process.stderr.write(
        `Queue run ended ${String(outcome?.["kind"] ?? run["state"])}: ${runIdentity(commandId)}; continuing\n`,
      );
    }
  }
  return pendingRun;
}

async function active(runtimeDirectory: string): Promise<boolean> {
  let after: string | null = "";
  do {
    const reply = await send(runtimeDirectory, {
      operation: "status",
      parameters: { after, limit: 500 },
    });
    if (reply.kind === "error") throw new Error(reply.error.code);
    const runs = reply.result["runs"];
    if (!Array.isArray(runs)) throw new Error("invalid-run-list");
    if (
      runs.some((value: unknown) => {
        const run = record(value);
        return run?.["workflowId"] === "develop-issue" && !terminal(run);
      })
    )
      return true;
    const next = reply.result["next"];
    if (next !== null && (typeof next !== "string" || next <= after))
      throw new Error("invalid-run-page");
    after = next;
  } while (after !== null);
  return false;
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
      workflowId: "develop-issue",
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
  if (!["no-ready-ticket", "workflow-active"].includes(reply.error.code))
    throw new Error(reply.error.code);
  pending.commands.delete(commandId);
  await pending.save();
}

function updateHold(directory: string): () => Promise<boolean> {
  let notice: string | undefined;
  return async () => {
    const mark = await readFile(
      join(directory, "pending-self-update"),
      "utf8",
    ).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return undefined;
      throw error;
    });
    if (mark === undefined) {
      notice = undefined;
      return false;
    }
    const timestamp = Number(mark);
    if (!Number.isFinite(timestamp) || timestamp <= 0)
      throw new Error("invalid-pending-self-update");
    const holding = Date.now() - timestamp < 30 * 60 * 1000;
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
    if (!(await attempt.holding()) && !attempt.signal.aborted)
      await submit(settings, attempt.pending);
  } finally {
    await rm(file, { force: true });
  }
}

async function cycle(
  settings: QueueSettings,
  signal: AbortSignal,
): Promise<void> {
  const pending = await journal(settings.directory);
  const holding = updateHold(settings.directory);
  await rm(join(settings.directory, "queue-submission"), { force: true });
  await recover(settings, pending);
  const stopped = (): boolean => signal.aborted;
  while (!stopped()) {
    await delay(settings.intervalMilliseconds, undefined, { signal }).catch(
      () => undefined,
    );
    if (stopped()) return;
    if (await completed(settings, pending)) continue;
    if (await active(settings.runtimeDirectory)) continue;
    if (await holding()) continue;
    if (stopped()) return;
    await admission(settings, { pending, holding, signal });
  }
}

export function issueQueue(settings: QueueSettings): {
  readonly stop: () => Promise<void>;
} {
  const stopping = new AbortController();
  const running = cycle(settings, stopping.signal).catch((error: unknown) => {
    const reason = error instanceof Error ? error.message : String(error);
    const diagnostic =
      error instanceof QueueFailureLimit ? reason : JSON.stringify(reason);
    process.stderr.write(`Queue stopped: ${diagnostic}\n`);
  });
  return {
    stop: async () => {
      stopping.abort();
      await running;
    },
  };
}
