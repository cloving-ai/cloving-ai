import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
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
  readonly save: () => Promise<void>;
  retryCommandId: string | undefined;
}

async function journal(directory: string): Promise<QueueJournal> {
  const file = join(directory, "queue-commands.json");
  const text = await readFile(file, "utf8").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return "[]";
    throw error;
  });
  const value: unknown = JSON.parse(text);
  if (
    !Array.isArray(value) ||
    !value.every((id) => typeof id === "string" && id.length > 0)
  )
    throw new Error("invalid-queue-commands");
  const commands = new Set(value.map(String));
  return {
    commands,
    retryCommandId: undefined,
    save: async () => {
      await writeFile(`${file}.tmp`, JSON.stringify([...commands]) + "\n", {
        mode: 0o600,
        flush: true,
      });
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

async function completed(
  settings: QueueSettings,
  pending: QueueJournal,
): Promise<boolean> {
  let failure: string | undefined;
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
    if (!handedOff(run))
      failure ??= JSON.stringify({
        runId: run["runId"],
        state: run["state"],
        outcome: run["outcome"] ?? null,
      });
    pending.commands.delete(commandId);
    await pending.save();
  }
  if (failure !== undefined) throw new Error(failure);
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

async function cycle(
  settings: QueueSettings,
  signal: AbortSignal,
): Promise<void> {
  const pending = await journal(settings.directory);
  await recover(settings, pending);
  const stopped = (): boolean => signal.aborted;
  while (!stopped()) {
    await delay(settings.intervalMilliseconds, undefined, { signal }).catch(
      () => undefined,
    );
    if (stopped()) return;
    if (await completed(settings, pending)) continue;
    if (await active(settings.runtimeDirectory)) continue;
    if (stopped()) return;
    await submit(settings, pending);
  }
}

export function issueQueue(settings: QueueSettings): {
  readonly stop: () => Promise<void>;
} {
  const stopping = new AbortController();
  const running = cycle(settings, stopping.signal).catch((error: unknown) => {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Queue stopped: ${JSON.stringify(reason)}\n`);
  });
  return {
    stop: async () => {
      stopping.abort();
      await running;
    },
  };
}
