import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { QueueJournal } from "./queue-journal.ts";
import {
  restartMark,
  restartText,
  type RestartPort,
} from "../restart-request.ts";

function absent(error: unknown): string {
  if (error instanceof Error && "code" in error && error.code === "ENOENT")
    return "";
  throw error;
}

export function restartMarks(directory: string): RestartPort {
  const file = join(directory, "pending-restart");
  const pending = async () =>
    restartMark(await readFile(file, "utf8").catch(absent));
  return {
    pending,
    request: async (mark) => {
      const temporary = `${file}-${randomUUID()}.tmp`;
      await writeFile(temporary, restartText(mark), { mode: 0o600 });
      await rename(temporary, file);
    },
    cancel: async () => {
      const had = (await pending()) !== undefined;
      await rm(file, { force: true });
      return had;
    },
  };
}

export function restartHold(directory: string): () => Promise<boolean> {
  const marks = restartMarks(directory);
  let noticed = false;
  return async () => {
    const holding = (await marks.pending()) !== undefined;
    if (holding && !noticed)
      process.stderr.write("Queue holding for pending restart\n");
    noticed = holding;
    return holding;
  };
}

async function removed(file: string): Promise<boolean> {
  try {
    await rm(file);
    return true;
  } catch (error) {
    return absent(error) !== "";
  }
}

export async function startedQueue(
  settings: { readonly directory: string; readonly resetQueue?: boolean },
  pending: Pick<QueueJournal, "failures" | "save"> & {
    drain: QueueJournal["drain"];
  },
): Promise<void> {
  const resumed = await removed(join(settings.directory, "resume-queue"));
  if (settings.resetQueue !== true && !resumed) return;
  if (settings.resetQueue === true) pending.failures.length = 0;
  pending.drain = undefined;
  await pending.save();
}
