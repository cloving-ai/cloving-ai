import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ciRerunNotices } from "./github-ci-progress.ts";
import { turnActivity, turnOf, type GithubRecords } from "./watch-model.ts";
import type { WatchItem, WatchTurn } from "./watch-render.ts";

export interface JournalCache {
  readonly runtimeDirectory: string;
  readonly streams: Map<
    string,
    { size: number; activity: readonly WatchItem[] }
  >;
  readonly github: Map<string, GithubRecords>;
}

function parsed(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    return null;
  }
}

interface Stream {
  readonly size: number;
  readonly activity: readonly WatchItem[];
  readonly activeAt: string | null;
}

const noStream: Stream = { size: 0, activity: [], activeAt: null };

async function streamed(watch: JournalCache, file: string): Promise<Stream> {
  const found = await stat(file).catch(() => null);
  if (found === null) return noStream;
  const known = watch.streams.get(file);
  const activeAt = found.mtime.toISOString();
  if (known?.size === found.size) return { ...known, activeAt };
  const activity = turnActivity(
    (await readFile(file, "utf8").catch(() => "")).split("\n"),
  );
  watch.streams.set(file, { size: found.size, activity });
  return { size: found.size, activity, activeAt };
}

async function stored(file: string): Promise<unknown> {
  return parsed(await readFile(file, "utf8").catch(() => "null"));
}

export async function journalTurns(watch: JournalCache): Promise<WatchTurn[]> {
  const journal = join(dirname(watch.runtimeDirectory), "journal");
  const found: WatchTurn[] = [];
  for (const key of await readdir(journal).catch(() => [])) {
    const started = await stored(join(journal, key, "started.json"));
    if (started === null) continue;
    const stream = await streamed(watch, join(journal, key, "turn.jsonl"));
    found.push(
      turnOf({
        key,
        started,
        result: await stored(join(journal, key, "result.json")),
        activity: stream.activity,
        activeAt: stream.activeAt,
      }),
    );
  }
  return found.toSorted((first, second) =>
    first.startedAt < second.startedAt ? -1 : 1,
  );
}

export async function githubRecords(
  watch: JournalCache,
): Promise<GithubRecords[]> {
  const journal = join(dirname(watch.runtimeDirectory), "github");
  const keys = await readdir(journal).catch(() => []);
  for (const key of keys) {
    const known = watch.github.get(key);
    if (known !== undefined && known.result !== null) continue;
    const started =
      known?.started ?? (await stored(join(journal, key, "started.json")));
    if (started === null) continue;
    const result = await stored(join(journal, key, "result.json"));
    watch.github.set(key, {
      started,
      result,
      ciReruns: await ciRerunNotices(join(journal, key)),
    });
  }
  return keys.flatMap((key) => watch.github.get(key) ?? []);
}
