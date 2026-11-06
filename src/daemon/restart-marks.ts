import { randomUUID } from "node:crypto";
import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { QueueJournal } from "./queue-journal.ts";
import {
  isRestartRequest,
  newestRestart,
  restartFiles,
  restartMark,
  restartText,
  type RestartEntry,
  type RestartPort,
} from "../restart-request.ts";

function absent(error: unknown): string {
  if (error instanceof Error && "code" in error && error.code === "ENOENT")
    return "";
  throw error;
}

function noNames(error: unknown): readonly string[] {
  absent(error);
  return [];
}

async function markIn(file: string) {
  return restartMark(await readFile(file, "utf8").catch(absent));
}

async function requestNames(directory: string): Promise<readonly string[]> {
  const names = await readdir(directory).catch(noNames);
  return names.filter(isRestartRequest);
}

async function requests(directory: string): Promise<readonly RestartEntry[]> {
  return Promise.all(
    (await requestNames(directory)).map(async (name) => ({
      name,
      text: await readFile(join(directory, name), "utf8").catch(absent),
    })),
  );
}

async function taken(directory: string, name: string): Promise<RestartEntry> {
  const place = join(directory, `restart-${randomUUID()}.cancelled`);
  await rename(join(directory, name), place).catch(absent);
  const text = await readFile(place, "utf8").catch(absent);
  await rm(place, { force: true });
  return { name, text };
}

let order: Promise<unknown> = Promise.resolve();

function inOrder<Value>(work: () => Promise<Value>): Promise<Value> {
  const next = order.then(work);
  order = next.catch(() => undefined);
  return next;
}

export function restartMarks(directory: string): RestartPort {
  const claimed = join(directory, restartFiles.claimed);
  return {
    pending: () =>
      inOrder(
        async () =>
          newestRestart(await requests(directory))?.mark ??
          (await markIn(claimed)),
      ),
    request: (mark) =>
      inOrder(async () => {
        const earlier = await requestNames(directory);
        const temporary = join(directory, `restart-${randomUUID()}.tmp`);
        await writeFile(temporary, restartText(mark), { mode: 0o600 });
        await rename(
          temporary,
          join(directory, `${restartFiles.request}${randomUUID()}`),
        );
        await Promise.all(
          earlier.map((name) => rm(join(directory, name), { force: true })),
        );
      }),
    cancel: () =>
      inOrder(async () => {
        const names = await requestNames(directory);
        const cancelled = await Promise.all(
          names.map((name) => taken(directory, name)),
        );
        if (newestRestart(cancelled) !== undefined) return "cancelled";
        return (await markIn(claimed)) === undefined ? "none" : "started";
      }),
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
