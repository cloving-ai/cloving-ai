import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Reply } from "../protocol.ts";
import type { FeedPick } from "../queue-feed.ts";
import { send } from "../cli/client.ts";
import type { QueueJournal } from "./queue-journal.ts";

interface QueueSettings {
  readonly directory: string;
  readonly runtimeDirectory: string;
  readonly queueDirectory?: string;
  readonly workflowId: string;
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

export async function admission(
  settings: QueueSettings,
  attempt: {
    readonly pending: QueueJournal;
    readonly holding: () => Promise<boolean>;
    readonly signal: AbortSignal;
  },
): Promise<void> {
  return queueSubmission(settings, async () => {
    if (
      !(await attempt.holding()) &&
      !attempt.signal.aborted &&
      attempt.pending.drain === undefined
    )
      await submit(settings, attempt.pending);
  });
}

async function queueSubmission<Result>(
  settings: QueueSettings,
  work: () => Promise<Result>,
): Promise<Result> {
  const file = join(
    settings.queueDirectory ?? settings.directory,
    "queue-submission",
  );
  await writeFile(file, "", { mode: 0o600 });
  try {
    return await work();
  } finally {
    await rm(file, { force: true });
  }
}

export function feedPick(
  settings: QueueSettings,
  attempt: {
    readonly pending: QueueJournal;
    readonly commandId: string;
    readonly pick: FeedPick;
    readonly available: () => Promise<boolean>;
  },
): Promise<Reply | undefined> {
  return queueSubmission(settings, async () => {
    if (!(await attempt.available())) return undefined;
    const { pending, commandId, pick } = attempt;
    pending.commands.add(commandId);
    await pending.save();
    const reply = await send(settings.runtimeDirectory, {
      operation: "run",
      parameters: {
        workflowId: settings.workflowId,
        commandId,
        source: "feed",
        submission: { ticket: pick },
      },
    });
    if (reply.kind === "error") {
      pending.commands.delete(commandId);
      await pending.save();
    }
    return reply;
  });
}
