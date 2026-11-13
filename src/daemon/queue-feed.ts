import { feedPick } from "./queue-submission.ts";
import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { send } from "../cli/client.ts";
import { record, type Reply } from "../protocol.ts";
import { checkedFeedResult, type FeedSkipped } from "../queue-feed.ts";
import { runIdentity } from "../service/submission-handler.ts";
import type { QueueJournal } from "./queue-journal.ts";

export interface FeedStatus {
  readonly at: string;
  readonly picks: number;
  readonly skipped: readonly FeedSkipped[];
}

interface Settings {
  readonly directory: string;
  readonly queueDirectory?: string;
  readonly runtimeDirectory: string;
  readonly workflowId: string;
  readonly intervalMilliseconds: number;
  readonly clock?: () => number;
}

interface Progress {
  inWork: FeedSkipped[];
  commandId?: string;
  index: number;
  notBefore: number;
  last?: FeedStatus;
}

async function load(file: string): Promise<Progress> {
  const text = await readFile(file, "utf8").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return "{}";
    throw error;
  });
  return progressOf(JSON.parse(text));
}

function boundedCount(value: unknown, maximum: number): boolean {
  return (
    Number.isSafeInteger(value) &&
    Number(value) >= 0 &&
    Number(value) <= maximum
  );
}

function lastStatus(value: unknown): FeedStatus | undefined {
  if (value === undefined) return undefined;
  const status = record(value);
  const skipped = status?.["skipped"];
  if (
    typeof status?.["at"] !== "string" ||
    !Number.isFinite(Date.parse(status["at"])) ||
    !boundedCount(status["picks"], 20) ||
    !Array.isArray(skipped) ||
    skipped.length > 70 ||
    skipped.some(
      (item: unknown) =>
        checkedFeedResult({ picks: [], skipped: [item] }) === undefined,
    )
  )
    throw new Error("invalid-feed-journal");
  return {
    at: status["at"],
    picks: Number(status["picks"]),
    skipped: skipped.map((item: unknown) => {
      const fields = record(item) ?? {};
      return { id: String(fields["id"]), reason: String(fields["reason"]) };
    }),
  };
}

function savedCommand(value: unknown): string | undefined {
  if (value === undefined || typeof value === "string") return value;
  throw new Error("invalid-feed-journal");
}

function savedInWork(value: unknown): FeedSkipped[] {
  const checked = checkedFeedResult({ picks: [], skipped: value ?? [] });
  if (checked === undefined || checked.skipped.length > 20)
    throw new Error("invalid-feed-journal");
  return [...checked.skipped];
}

function progressOf(value: unknown): Progress {
  const fields = record(value);
  if (fields === undefined) throw new Error("invalid-feed-journal");
  const { index = 0, notBefore = 0 } = fields;
  const commandId = savedCommand(fields["commandId"]);
  if (
    !boundedCount(index, 20) ||
    typeof notBefore !== "number" ||
    !Number.isFinite(notBefore)
  )
    throw new Error("invalid-feed-journal");
  const inWork = savedInWork(fields["inWork"]);
  const last = lastStatus(fields["last"]);
  return {
    inWork,
    index: Number(index),
    notBefore,
    ...(typeof commandId === "string" ? { commandId } : {}),
    ...(last === undefined ? {} : { last }),
  };
}

export async function queueFeed(
  settings: Settings,
  shown: (status: FeedStatus) => void,
) {
  const file = join(
    settings.queueDirectory ?? settings.directory,
    "queue-feed.json",
  );
  const progress = await load(file);
  if (progress.last !== undefined) shown(progress.last);
  const save = async () => {
    await writeFile(`${file}.tmp`, JSON.stringify(progress) + "\n", {
      mode: 0o600,
      flush: true,
    });
    await rename(`${file}.tmp`, file);
  };
  const reset = async () => {
    progress.notBefore = 0;
    await save();
  };
  const finish = async () => {
    delete progress.commandId;
    progress.index = 0;
    progress.inWork = [];
    await save();
  };
  const next = async (attempt: Attempt) => {
    if (progress.commandId === undefined) {
      if (
        !(await attempt.available()) ||
        (settings.clock ?? Date.now)() < progress.notBefore
      )
        return;
      progress.commandId = randomUUID();
      await save();
    }
    const status = await readFeed(settings, progress.commandId);
    if (status === "refused") return finish();
    if (status === undefined) return;
    await admitResult(settings, {
      progress,
      save,
      shown,
      attempt,
      result: status["result"],
      at: String(status["at"]),
    });
    await finish();
  };
  return { next, reset };
}

async function readFeed(settings: Settings, commandId: string) {
  const reply = await send(settings.runtimeDirectory, {
    operation: "queue-feed",
    parameters: {
      workflowId: settings.workflowId,
      commandId: commandId,
    },
  });
  if (reply.kind === "error") {
    if (
      [
        "feed-active",
        "workflow-active",
        "queue-spend-limit",
        "queue-repository-full",
      ].includes(reply.error.code)
    )
      return "refused";
    throw new Error(reply.error.code);
  }
  const status = await send(settings.runtimeDirectory, {
    operation: "queue-feed",
    parameters: { action: "status", runId: runIdentity(commandId) },
  });
  if (status.kind === "error") throw new Error(status.error.code);
  if (["failed", "cancelled"].includes(String(status.result["state"])))
    throw new Error("queue-feed-failed");
  return status.result["state"] === "completed" ? status.result : undefined;
}

interface Attempt {
  readonly pending: QueueJournal;
  readonly available: () => Promise<boolean>;
  readonly release: () => void;
}

async function admitResult(
  settings: Settings,
  context: {
    readonly progress: Progress;
    readonly save: () => Promise<void>;
    readonly shown: (status: FeedStatus) => void;
    readonly attempt: Attempt;
    readonly result: unknown;
    readonly at: string;
  },
): Promise<void> {
  const result = checkedFeedResult(context.result);
  if (result === undefined) throw new Error("invalid-feed-result");
  const { progress, attempt, save } = context;
  const skipped = [...result.skipped, ...progress.inWork];
  progress.notBefore =
    result.picks.length === 0
      ? (settings.clock ?? Date.now)() +
        Math.min(settings.intervalMilliseconds * 4, 900_000)
      : 0;
  for (const [index, pick] of result.picks.entries()) {
    if (index < progress.index) continue;
    attempt.release();
    const commandId = `${String(progress.commandId)}:pick:${String(index)}`;
    if (attempt.pending.commands.has(commandId)) {
      progress.index = index + 1;
      await save();
      continue;
    }
    const reply = await feedPick(settings, {
      pending: attempt.pending,
      commandId,
      pick,
      available: attempt.available,
    });
    const outcome = pickOutcome(reply);
    if (outcome === "held") break;
    if (outcome === "in work") {
      const item = { id: pick.id, reason: "in work" };
      progress.inWork.push(item);
      skipped.push(item);
    }
    progress.index = index + 1;
    await save();
  }
  progress.last = { at: context.at, picks: result.picks.length, skipped };
  context.shown(progress.last);
  await save();
}

function pickOutcome(
  reply: Reply | undefined,
): "admitted" | "in work" | "held" {
  if (reply === undefined) return "held";
  if (reply.kind === "result") return "admitted";
  const { code } = reply.error;
  if (
    ["workflow-active", "queue-spend-limit", "queue-repository-full"].includes(
      code,
    )
  )
    return "held";
  if (code === "ticket-active") return "in work";
  throw new Error(code);
}
