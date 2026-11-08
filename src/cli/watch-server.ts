import {
  watchAction,
  watchActions,
  watchHost,
  type WatchActions,
} from "./watch-actions.ts";
import { watchApiChange, watchApiReply, type ApiRequest } from "./watch-api.ts";
import { transcriptStreamed } from "./watch-transcript-stream.ts";
import type { TranscriptFeed } from "./watch-api-transcript.ts";
import {
  githubRecords,
  journalTurns,
  type JournalCache,
} from "./watch-journal.ts";
import { send } from "./client.ts";
import { observedBoard } from "./watch-pr-board.ts";
import { finishedModel, type IssueState } from "./watch-finished.ts";
import { isPhoneAction, phoneAction, phoneRead } from "./watch-phone.ts";
import { queueAction } from "./watch-queue.ts";
import { continueAction, dismissAction } from "./watch-continue.ts";
import { watchPrObserver, type WatchPrSettings } from "./watch-pr-settings.ts";
import type { PrObserver } from "./watch-pr-observer.ts";
import { readFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type RequestListener,
} from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { watchReader, type WatchReader } from "./watch-reads.ts";
import { watchModel, type GithubRecords } from "./watch-model.ts";
import { pageDocument } from "./watch-page.ts";
import type { WatchItem, WatchModel } from "./watch-render.ts";
import { watchStream, type WatchStream } from "./watch-stream.ts";
import {
  threadPoolWatch,
  type ThreadPoolSettings,
  type ThreadPoolWatch,
} from "./thread-pool.ts";
import { stalledLine, threadPoolStallExitCode } from "../thread-pool-check.ts";
import {
  deadlined,
  defaultReplyMilliseconds,
  notFound,
  replied,
  subscribed,
  type Reply,
} from "./watch-reply.ts";
import { fontReply } from "./watch-font-reply.ts";
import {
  themeFile,
  watchThemes,
  type WatchThemeSettings,
} from "./watch-themes.ts";

export const defaultWatchPort = 3663;

export interface WatchSettings {
  readonly actions?: string;
  readonly pullRequests?: WatchPrSettings;
  readonly themes?: WatchThemeSettings;
  readonly runtimeDirectory: string;
  readonly retentionDays?: number | null;
  readonly replyMilliseconds?: number;
  readonly threadPool?: ThreadPoolSettings;
  readonly port: number;
  readonly client: string;
  readonly announce: (text: string) => void;
  readonly complain: (text: string) => void;
  readonly stopped: Promise<void>;
}

interface Watch {
  readonly actions: WatchActions | null;
  readonly settings: WatchSettings;
  readonly observer: PrObserver;
  readonly pool: ThreadPoolWatch;
  readonly reader: WatchReader;
  readonly streams: Map<
    string,
    { size: number; activity: readonly WatchItem[] }
  >;
  readonly github: Map<string, GithubRecords>;
}

const unknownIssue = (): IssueState => "unknown";
const forbidden: Reply = { status: 403, type: "text/plain", body: "refused" };
const libraryFile = fileURLToPath(import.meta.resolve("preact"));
const pageChange = (): string => "data: change\n\n";
const artPolicy = "default-src 'none'; style-src 'unsafe-inline'";
function journalCache(watch: Watch): JournalCache {
  return {
    runtimeDirectory: watch.settings.runtimeDirectory,
    streams: watch.streams,
    github: watch.github,
  };
}

async function snapshot(
  watch: Watch,
  runId: string | null,
): Promise<WatchModel> {
  const updatedAt = new Date().toISOString();
  const [read, journal, github] = await Promise.all([
    runId === null ? watch.reader.read(updatedAt) : watch.reader.run(runId),
    journalTurns(journalCache(watch)),
    githubRecords(journalCache(watch)),
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
  const shown =
    runId === null
      ? observedBoard(
          finishedModel(model, {
            issue: watch.observer.issueState ?? unknownIssue,
            pullRequest: watch.observer.observe,
            retentionDays: watch.settings.retentionDays ?? null,
          }),
          watch.observer,
        )
      : model;
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

function routedAction(path: string): typeof watchAction | null {
  if (isPhoneAction(path)) return phoneAction;
  if (path === "/actions/queue") return queueAction;
  if (path === "/actions/continue") return continueAction;
  if (path === "/actions/dismiss") return dismissAction;
  return path === "/actions/run" ? watchAction : null;
}

function apiRequest(
  watch: Watch,
  exchange: { readonly request: IncomingMessage; readonly url: URL },
): ApiRequest {
  const { request, url } = exchange;
  return {
    method: request.method ?? "",
    url,
    lastEventId: request.headers["last-event-id"]?.toString() ?? null,
    model: () => snapshot(watch, null),
    run: (runId) => snapshot(watch, runId),
    transcript: (query) =>
      send(watch.settings.runtimeDirectory, {
        operation: "transcript",
        parameters: { ...query },
      }),
  };
}

async function answered(
  watch: Watch,
  request: IncomingMessage,
): Promise<Reply | "stream" | TranscriptFeed> {
  if (!watchHost(request)) return forbidden;
  const font = await fontReply(request);
  if (font !== null) return font;
  const url = new URL(String(request.url), "http://localhost");
  const api = await watchApiReply(apiRequest(watch, { request, url }));
  if (api !== null) return api;
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
  if (path === "/") return pageReply(watch);
  if (path.startsWith("/themes/")) return themeReply(watch, path);
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
  if (path === "/health.json") return healthReply(watch.pool);
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

function healthReply(pool: ThreadPoolWatch): Reply {
  return {
    status: 200,
    type: "application/json",
    body: JSON.stringify({ threadPool: pool.latest() ?? null }),
  };
}

async function pageReply(watch: Watch): Promise<Reply> {
  const { themes } = watch.settings;
  return {
    status: 200,
    type: "text/html; charset=utf-8",
    body: pageDocument(
      watch.actions?.token ?? null,
      themes === undefined ? undefined : await watchThemes(themes),
    ),
  };
}

async function themeReply(watch: Watch, path: string): Promise<Reply> {
  const folders = watch.settings.themes?.folders;
  const file = folders === undefined ? null : await themeFile(folders, path);
  return file === null
    ? notFound
    : { status: 200, type: file.type, body: file.body, policy: artPolicy };
}

function requestHandler(watch: Watch, stream: WatchStream): RequestListener {
  return (request, response) => {
    if (
      watchHost(request) &&
      request.method === "GET" &&
      request.url === "/events"
    ) {
      subscribed(stream, { request, response, message: pageChange });
      return;
    }
    deadlined(answered(watch, request), {
      request,
      milliseconds:
        watch.settings.replyMilliseconds ?? defaultReplyMilliseconds,
      complain: watch.settings.complain,
    }).then(
      (reply) => {
        if (reply === "stream")
          subscribed(stream, { request, response, message: watchApiChange });
        else if ("kind" in reply)
          transcriptStreamed(reply, { request, response, stream });
        else replied(response, reply);
      },
      () => {
        replied(response, { ...notFound, status: 500, body: "failed" });
      },
    );
  };
}

async function served(
  settings: WatchSettings,
  pool: ThreadPoolWatch,
): Promise<number> {
  const observer = await observerFor(settings);
  const watch: Watch = {
    actions:
      settings.actions === "off"
        ? null
        : await watchActions(settings.runtimeDirectory),
    settings,
    observer,
    pool,
    reader: watchReader(settings.runtimeDirectory, observer.repository ?? null),
    streams: new Map(),
    github: new Map(),
  };
  const stream = watchStream({
    runtimeDirectory: settings.runtimeDirectory,
    journal: join(dirname(settings.runtimeDirectory), "journal"),
    retryMilliseconds: 1000,
  });
  const server = createServer(requestHandler(watch, stream));
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

export async function watchServer(settings: WatchSettings): Promise<number> {
  const stall = Promise.withResolvers<number>();
  const pool = threadPoolWatch({
    ...settings.threadPool,
    stalled: (check) => {
      settings.complain(stalledLine(check));
      stall.resolve(threadPoolStallExitCode);
    },
  });
  const stopped = Promise.race([
    settings.stopped,
    stall.promise.then(() => undefined),
  ]);
  try {
    return await Promise.race([
      served({ ...settings, stopped }, pool),
      stall.promise,
    ]);
  } finally {
    pool.stop();
  }
}

function observerFor(settings: WatchSettings): Promise<PrObserver> {
  if (settings.pullRequests !== undefined)
    return watchPrObserver(settings.pullRequests);
  return Promise.resolve({
    observe: () => ({ status: "unavailable", failure: "configuration" }),
    close: () => undefined,
  });
}
