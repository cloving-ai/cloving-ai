import { readdir, readFile, stat } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { watchReader, type WatchReader } from "./watch-reads.ts";
import { turnOf, watchModel, type GithubRecords } from "./watch-model.ts";
import { pageDocument } from "./watch-page.ts";
import type { WatchModel, WatchTurn } from "./watch-render.ts";
import { watchStream, type WatchStream } from "./watch-stream.ts";

export const defaultWatchPort = 3663;

export interface WatchSettings {
  readonly runtimeDirectory: string;
  readonly port: number;
  readonly client: string;
  readonly announce: (text: string) => void;
  readonly complain: (text: string) => void;
  readonly stopped: Promise<void>;
}

interface Reply {
  readonly status: number;
  readonly type: string;
  readonly body: string;
}

interface Watch {
  readonly settings: WatchSettings;
  readonly reader: WatchReader;
  readonly streams: Map<string, { size: number; lines: readonly string[] }>;
  readonly github: Map<string, GithubRecords>;
}

const notFound: Reply = { status: 404, type: "text/plain", body: "not found" };
const libraryFile = fileURLToPath(import.meta.resolve("preact"));
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
  readonly lines: readonly string[];
  readonly activeAt: string | null;
}

const noStream: Stream = { size: 0, lines: [], activeAt: null };

async function streamed(watch: Watch, file: string): Promise<Stream> {
  const found = await stat(file).catch(() => null);
  if (found === null) return noStream;
  const known = watch.streams.get(file);
  const activeAt = found.mtime.toISOString();
  if (known?.size === found.size) return { ...known, activeAt };
  const lines = (await readFile(file, "utf8").catch(() => "")).split("\n");
  watch.streams.set(file, { size: found.size, lines });
  return { size: found.size, lines, activeAt };
}

async function stored(file: string): Promise<unknown> {
  return parsed(await readFile(file, "utf8").catch(() => "null"));
}

async function turns(watch: Watch): Promise<WatchTurn[]> {
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
        lines: stream.lines,
        activeAt: stream.activeAt,
      }),
    );
  }
  return found.toSorted((first, second) =>
    first.startedAt < second.startedAt ? -1 : 1,
  );
}

async function githubRecords(watch: Watch): Promise<GithubRecords[]> {
  const journal = join(dirname(watch.settings.runtimeDirectory), "github");
  const keys = await readdir(journal).catch(() => []);
  for (const key of keys) {
    const known = watch.github.get(key);
    if (known !== undefined && known.result !== null) continue;
    const started =
      known?.started ?? (await stored(join(journal, key, "started.json")));
    if (started === null) continue;
    const result = await stored(join(journal, key, "result.json"));
    watch.github.set(key, { started, result });
  }
  return keys.flatMap((key) => watch.github.get(key) ?? []);
}

async function snapshot(
  watch: Watch,
  runId: string | null,
): Promise<WatchModel> {
  const updatedAt = new Date().toISOString();
  const [read, journal, github] = await Promise.all([
    runId === null ? watch.reader.read(updatedAt) : watch.reader.run(runId),
    turns(watch),
    githubRecords(watch),
  ]);
  return watchModel({
    ...read,
    host: dirname(watch.settings.runtimeDirectory),
    client: watch.settings.client,
    updatedAt,
    turns: journal,
    githubRecords: github,
  });
}

async function answered(
  watch: Watch,
  request: {
    readonly method?: string | undefined;
    readonly url?: string | undefined;
  },
): Promise<Reply> {
  const url = new URL(String(request.url), "http://localhost");
  const path = url.pathname;
  if (request.method !== "GET") return notFound;
  if (path === "/")
    return {
      status: 200,
      type: "text/html; charset=utf-8",
      body: pageDocument(),
    };
  if (path === "/preact.mjs")
    return {
      status: 200,
      type: "text/javascript; charset=utf-8",
      body: await readFile(libraryFile, "utf8"),
    };
  if (path !== "/data.json") return notFound;
  const runId = url.searchParams.get("runId");
  const model = await snapshot(watch, runId);
  if (runId !== null && model.runs.length === 0) return notFound;
  return {
    status: 200,
    type: "application/json",
    body: JSON.stringify(runId === null ? model : { run: model.runs[0] }),
  };
}

function replied(response: ServerResponse, reply: Reply): void {
  response.writeHead(reply.status, {
    "content-type": reply.type,
    "cache-control": "no-store",
  });
  response.end(reply.body);
}

function subscribed(
  stream: WatchStream,
  exchange: {
    readonly request: IncomingMessage;
    readonly response: ServerResponse;
  },
): void {
  const { request, response } = exchange;
  const changed = (): void => {
    response.write("data: change\n\n");
  };
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
  });
  changed();
  request.once("close", stream.subscribe(changed));
}

export function watchServer(settings: WatchSettings): Promise<number> {
  const watch: Watch = {
    settings,
    reader: watchReader(settings.runtimeDirectory),
    streams: new Map(),
    github: new Map(),
  };
  const stream = watchStream({
    runtimeDirectory: settings.runtimeDirectory,
    journal: join(dirname(settings.runtimeDirectory), "journal"),
    retryMilliseconds: 1000,
  });
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/events") {
      subscribed(stream, { request, response });
      return;
    }
    answered(watch, request).then(
      (reply) => {
        replied(response, reply);
      },
      () => {
        replied(response, { ...notFound, status: 500, body: "failed" });
      },
    );
  });
  return new Promise((settle) => {
    server.once("error", (error) => {
      stream.close();
      settings.complain(`watch-not-started: ${error.message}\n`);
      settle(1);
    });
    server.listen(settings.port, "127.0.0.1", () => {
      const bound: unknown = Reflect.get(Object(server.address()), "port");
      settings.announce(`Watch page: http://127.0.0.1:${String(bound)}/\n`);
    });
    const closed = (): void => {
      stream.close();
      server.close();
      server.closeAllConnections();
      settle(0);
    };
    settings.stopped.then(closed, closed);
  });
}
