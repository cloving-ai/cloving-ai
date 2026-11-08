import { observedBoard } from "./watch-pr-board.ts";
import { finishedModel, type IssueState } from "./watch-finished.ts";
import { watchPrObserver, type WatchPrSettings } from "./watch-pr-settings.ts";
import type { PrObserver } from "./watch-pr-observer.ts";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { watchReader, type WatchReader } from "./watch-reads.ts";
import { ciRerunNotices } from "./github-ci-progress.ts";
import {
  turnActivity,
  turnOf,
  watchModel,
  type GithubRecords,
} from "./watch-model.ts";
import type { WatchItem, WatchModel, WatchTurn } from "./watch-render.ts";
import { watchStream, type WatchStream } from "./watch-stream.ts";
import { workspaceModel } from "./watch-workspace.ts";

export interface SnapshotSettings {
  readonly runtimeDirectory: string;
  readonly pullRequests?: WatchPrSettings | undefined;
  readonly retentionDays?: number | null | undefined;
  readonly client: string;
}

export interface WatchMember {
  readonly name: string;
  readonly runtimeDirectory: string;
  readonly pullRequests?: WatchPrSettings | undefined;
}

export interface WatchSnapshots {
  readonly snapshot: (runId: string | null) => Promise<WatchModel>;
  readonly stream: WatchStream;
  readonly close: () => void;
}

interface Snapshots {
  readonly settings: SnapshotSettings;
  readonly observer: PrObserver;
  readonly reader: WatchReader;
  readonly streams: Map<
    string,
    { size: number; activity: readonly WatchItem[] }
  >;
  readonly github: Map<string, GithubRecords>;
}

const unknownIssue = (): IssueState => "unknown";

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

async function streamed(watch: Snapshots, file: string): Promise<Stream> {
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

async function turns(watch: Snapshots): Promise<WatchTurn[]> {
  const journal = join(dirname(watch.settings.runtimeDirectory), "journal");
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

async function githubRecords(watch: Snapshots): Promise<GithubRecords[]> {
  const journal = join(dirname(watch.settings.runtimeDirectory), "github");
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

async function snapshot(
  watch: Snapshots,
  runId: string | null,
): Promise<WatchModel> {
  const updatedAt = new Date().toISOString();
  const [read, journal, github] = await Promise.all([
    runId === null ? watch.reader.read(updatedAt) : watch.reader.run(runId),
    turns(watch),
    githubRecords(watch),
  ]);
  const model = watchModel({
    ...read,
    repository: watch.observer.repository ?? null,
    home: homedir(),
    client: watch.settings.client,
    updatedAt,
    turns: journal,
    githubRecords: github,
  });
  if (runId !== null) return model;
  return observedBoard(
    finishedModel(model, {
      issue: watch.observer.issueState ?? unknownIssue,
      pullRequest: watch.observer.observe,
      retentionDays: watch.settings.retentionDays ?? null,
    }),
    watch.observer,
  );
}

function observerFor(settings: SnapshotSettings): Promise<PrObserver> {
  if (settings.pullRequests !== undefined)
    return watchPrObserver(settings.pullRequests);
  return Promise.resolve({
    observe: () => ({ status: "unavailable", failure: "configuration" }),
    close: () => undefined,
  });
}

export async function watchSnapshots(
  settings: SnapshotSettings,
): Promise<WatchSnapshots> {
  const observer = await observerFor(settings);
  const watch: Snapshots = {
    settings,
    observer,
    reader: watchReader(settings.runtimeDirectory, observer.repository ?? null),
    streams: new Map(),
    github: new Map(),
  };
  const stream = watchStream({
    runtimeDirectory: settings.runtimeDirectory,
    journal: join(dirname(settings.runtimeDirectory), "journal"),
    retryMilliseconds: 1000,
  });
  return {
    snapshot: (runId) => snapshot(watch, runId),
    stream,
    close: () => {
      observer.close();
      stream.close();
    },
  };
}

function joinedStream(parts: readonly WatchSnapshots[]): WatchStream {
  return {
    subscribe: (listener) => {
      const ends = parts.map((part) => part.stream.subscribe(listener));
      return () => {
        for (const end of ends) end();
      };
    },
    close: () => {
      for (const part of parts) part.close();
    },
  };
}

async function memberRun(
  members: readonly { readonly name: string; readonly own: WatchSnapshots }[],
  runId: string,
): Promise<WatchModel> {
  const models = await Promise.all(
    members.map(async ({ name, own }) => ({
      name,
      model: await own.snapshot(runId),
    })),
  );
  return workspaceModel(
    models.filter(({ model }) => model.runs.length > 0).slice(0, 1),
  );
}

export async function workspaceSnapshots(
  settings: Omit<SnapshotSettings, "runtimeDirectory" | "pullRequests"> & {
    readonly members: readonly WatchMember[];
  },
): Promise<WatchSnapshots> {
  const members = await Promise.all(
    settings.members.map(async (member) => ({
      name: member.name,
      own: await watchSnapshots({
        ...settings,
        runtimeDirectory: member.runtimeDirectory,
        pullRequests: member.pullRequests,
      }),
    })),
  );
  const stream = joinedStream(members.map(({ own }) => own));
  return {
    snapshot: async (runId) => {
      if (runId !== null) return memberRun(members, runId);
      return workspaceModel(
        await Promise.all(
          members.map(async ({ name, own }) => ({
            name,
            model: await own.snapshot(null),
          })),
        ),
      );
    },
    stream,
    close: stream.close,
  };
}
