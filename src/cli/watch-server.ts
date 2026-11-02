import {
  watchAction,
  watchActions,
  watchHost,
  type WatchActions,
} from "./watch-actions.ts";
import { observedBoard } from "./watch-pr-board.ts";
import { isPhoneAction, phoneAction, phoneRead } from "./watch-phone.ts";
import { watchPrObserver, type WatchPrSettings } from "./watch-pr-settings.ts";
import type { PrObserver } from "./watch-pr-observer.ts";
import { readdir, readFile, stat } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { watchReader, type WatchReader } from "./watch-reads.ts";
import { ciRerunNotices } from "./github-ci-progress.ts";
import {
  turnActivity,
  turnOf,
  watchModel,
  type GithubRecords,
} from "./watch-model.ts";
import { pageDocument } from "./watch-page.ts";
import type { WatchItem, WatchModel, WatchTurn } from "./watch-render.ts";
import { watchStream, type WatchStream } from "./watch-stream.ts";

export const defaultWatchPort = 3663;

export interface WatchSettings {
  readonly actions?: string;
  readonly pullRequests?: WatchPrSettings;
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
  readonly body: string | Uint8Array;
  readonly cache?: string;
}

interface Watch {
  readonly actions: WatchActions | null;
  readonly settings: WatchSettings;
  readonly observer: PrObserver;
  readonly reader: WatchReader;
  readonly streams: Map<
    string,
    { size: number; activity: readonly WatchItem[] }
  >;
  readonly github: Map<string, GithubRecords>;
}

const forbidden: Reply = { status: 403, type: "text/plain", body: "refused" };
const notFound: Reply = { status: 404, type: "text/plain", body: "not found" };
const fontFiles = new Map(
  [
    "fira-code-latin-400-normal.woff2",
    "fira-code-latin-500-normal.woff2",
    "heebo-latin-500-normal.woff2",
    "heebo-latin-700-normal.woff2",
    "heebo-latin-800-normal.woff2",
    "space-grotesk-latin-400-normal.woff2",
    "space-grotesk-latin-500-normal.woff2",
    "space-grotesk-latin-600-normal.woff2",
    "space-grotesk-latin-700-normal.woff2",
  ].map((name) => [
    `/watch-fonts-v1/${name}`,
    new URL(`assets/watch-fonts/${name}`, import.meta.resolve("#package")),
  ]),
);
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
  readonly activity: readonly WatchItem[];
  readonly activeAt: string | null;
}

const noStream: Stream = { size: 0, activity: [], activeAt: null };

async function streamed(watch: Watch, file: string): Promise<Stream> {
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
        activity: stream.activity,
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
    watch.github.set(key, {
      started,
      result,
      ciReruns: await ciRerunNotices(join(journal, key)),
    });
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
  const model = watchModel({
    ...read,
    repository: watch.observer.repository ?? null,
    home: homedir(),
    client: watch.settings.client,
    updatedAt,
    turns: journal,
    githubRecords: github,
  });
  const shown = runId === null ? observedBoard(model, watch.observer) : model;
  return {
    ...shown,
    cardForms:
      watch.actions?.forms.filter((form) =>
        shown.workflows.some(
          (workflow) => workflow.workflowId === form.workflowId,
        ),
      ) ?? [],
  };
}

async function fontReply(request: IncomingMessage): Promise<Reply | null> {
  const fontFile = fontFiles.get(request.url ?? "");
  if (fontFile === undefined)
    return request.url?.startsWith("/watch-fonts-v1/") ? notFound : null;
  if (request.method !== "GET") return notFound;
  return {
    status: 200,
    type: "font/woff2",
    body: await readFile(fontFile),
    cache: "public, max-age=31536000, immutable",
  };
}

function routedAction(
  path: string,
): typeof watchAction | typeof phoneAction | null {
  if (isPhoneAction(path)) return phoneAction;
  return path === "/actions/run" ? watchAction : null;
}

async function answered(
  watch: Watch,
  request: IncomingMessage,
): Promise<Reply> {
  if (!watchHost(request)) return forbidden;
  const font = await fontReply(request);
  if (font !== null) return font;
  const url = new URL(String(request.url), "http://localhost");
  if (request.method === "GET") return readReply(watch, url);
  if (request.method !== "POST" || watch.actions === null) return notFound;
  const act = routedAction(url.pathname);
  if (act === null) return notFound;
  const body = await act(watch.actions, request).catch(() => null);
  return body === null
    ? forbidden
    : { status: 200, type: "application/json", body };
}

async function readReply(watch: Watch, url: URL): Promise<Reply> {
  const path = url.pathname;
  if (path === "/")
    return {
      status: 200,
      type: "text/html; charset=utf-8",
      body: pageDocument(watch.actions?.token ?? null),
    };
  if (path === "/preact.mjs")
    return {
      status: 200,
      type: "text/javascript; charset=utf-8",
      body: await readFile(libraryFile, "utf8"),
    };
  if (path === "/phone.json")
    return {
      status: 200,
      type: "application/json",
      body: await phoneRead(watch.settings.runtimeDirectory),
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
    "cache-control": reply.cache ?? "no-store",
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

export async function watchServer(settings: WatchSettings): Promise<number> {
  const observer = await observerFor(settings);
  const watch: Watch = {
    actions:
      settings.actions === "off"
        ? null
        : await watchActions(settings.runtimeDirectory),
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
  const server = createServer((request, response) => {
    if (
      watchHost(request) &&
      request.method === "GET" &&
      request.url === "/events"
    ) {
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
      observer.close();
      stream.close();
      settings.complain(`watch-not-started: ${error.message}\n`);
      settle(1);
    });
    server.listen(settings.port, "127.0.0.1", () => {
      const bound: unknown = Reflect.get(Object(server.address()), "port");
      settings.announce(`Watch page: http://127.0.0.1:${String(bound)}/\n`);
    });
    const closed = (): void => {
      observer.close();
      stream.close();
      server.close();
      server.closeAllConnections();
      settle(0);
    };
    settings.stopped.then(closed, closed);
  });
}

function observerFor(settings: WatchSettings): Promise<PrObserver> {
  if (settings.pullRequests !== undefined)
    return watchPrObserver(settings.pullRequests);
  return Promise.resolve({
    observe: () => ({ status: "unavailable", failure: "configuration" }),
    close: () => undefined,
  });
}
