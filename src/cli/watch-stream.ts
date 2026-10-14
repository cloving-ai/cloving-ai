import { watch, type FSWatcher } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { follow, send } from "./client.ts";

export interface StreamSettings {
  readonly runtimeDirectory: string;
  readonly journal: string;
  readonly retryMilliseconds: number;
}

export interface WatchStream {
  readonly subscribe: (listener: () => void) => () => void;
  readonly close: () => void;
}

interface Stream {
  readonly settings: StreamSettings;
  readonly stopping: AbortController;
  readonly stopped: Promise<void>;
  readonly notify: () => void;
  readonly tails: Map<string, FSWatcher>;
}

const burstMilliseconds = 100;

export function throttled(
  notify: () => void,
  milliseconds: number,
): () => void {
  const burst = { open: false, again: false };
  const fire = (): void => {
    burst.open = true;
    setTimeout(ended, milliseconds).unref();
    notify();
  };
  const ended = (): void => {
    burst.open = false;
    if (!burst.again) return;
    burst.again = false;
    fire();
  };
  return () => {
    if (burst.open) burst.again = true;
    else fire();
  };
}

async function paused(stream: Stream): Promise<void> {
  const { signal } = stream.stopping;
  await delay(stream.settings.retryMilliseconds, undefined, { signal }).catch(
    () => undefined,
  );
}

async function serviceFollowed(stream: Stream): Promise<void> {
  const { runtimeDirectory } = stream.settings;
  while (!stream.stopping.signal.aborted) {
    const page = await send(runtimeDirectory, {
      operation: "events",
      parameters: { limit: 1 },
    });
    if (page.kind === "result") {
      stream.notify();
      const after = page.result["latestSequence"];
      await follow(runtimeDirectory, {
        request: { operation: "events", parameters: { after, follow: true } },
        onEvent: stream.notify,
        signal: stream.stopped,
      });
      stream.notify();
    }
    await paused(stream);
  }
}

async function openTurns(journal: string): Promise<string[]> {
  const files: string[] = [];
  for (const folder of await readdir(journal).catch(() => [])) {
    const ended = await stat(join(journal, folder, "result.json")).then(
      () => "ended",
      () => "open",
    );
    if (ended === "open") files.push(join(journal, folder, "turn.jsonl"));
  }
  return files;
}

function tailed(stream: Stream, file: string): void {
  if (stream.tails.has(file)) return;
  try {
    const watcher = watch(file, stream.notify);
    watcher.on("error", stream.notify);
    stream.tails.set(file, watcher);
  } catch {
    return;
  }
  stream.notify();
}

async function tailsRefreshed(stream: Stream): Promise<void> {
  const open = await openTurns(stream.settings.journal);
  for (const [file, watcher] of stream.tails) {
    if (open.includes(file)) continue;
    watcher.close();
    stream.tails.delete(file);
    stream.notify();
  }
  for (const file of open) tailed(stream, file);
}

async function journalWatched(stream: Stream): Promise<void> {
  while (!stream.stopping.signal.aborted) {
    await tailsRefreshed(stream);
    await paused(stream);
  }
  for (const watcher of stream.tails.values()) watcher.close();
}

export function watchStream(settings: StreamSettings): WatchStream {
  const listeners = new Set<() => void>();
  const stopping = new AbortController();
  const stream: Stream = {
    settings,
    stopping,
    stopped: new Promise((settle) => {
      stopping.signal.addEventListener("abort", () => {
        settle();
      });
    }),
    notify: throttled(() => {
      for (const listener of [...listeners]) listener();
    }, burstMilliseconds),
    tails: new Map(),
  };
  Promise.allSettled([serviceFollowed(stream), journalWatched(stream)]).then(
    () => undefined,
    () => undefined,
  );
  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close: () => {
      listeners.clear();
      stopping.abort();
    },
  };
}
