import {
  watchAction,
  watchActions,
  watchHost,
  type WatchActions,
} from "./watch-actions.ts";
import { watchApiChange, watchApiReply, type ApiRequest } from "./watch-api.ts";
import { transcriptStreamed } from "./watch-transcript-stream.ts";
import type {
  TranscriptFeed,
  TranscriptQuery,
} from "./watch-api-transcript.ts";
import { send } from "./client.ts";
import { isPhoneAction, phoneAction, phoneRead } from "./watch-phone.ts";
import { queueAction } from "./watch-queue.ts";
import { continueAction, dismissAction } from "./watch-continue.ts";
import type { WatchPrSettings } from "./watch-pr-settings.ts";
import { readFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type RequestListener,
} from "node:http";
import { fileURLToPath } from "node:url";
import { pageDocument } from "./watch-page.ts";
import type { WatchModel } from "./watch-render.ts";
import type { WatchStream } from "./watch-stream.ts";
import {
  watchSnapshots,
  workspaceSnapshots,
  type WatchMember,
  type WatchSnapshots,
} from "./watch-snapshot.ts";
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
import type { Reply as ServiceReply } from "../protocol.ts";
import { fontReply } from "./watch-font-reply.ts";
import {
  themeFile,
  watchThemes,
  type WatchThemeSettings,
} from "./watch-themes.ts";

export const defaultWatchPort = 3663;

interface ServedSettings {
  readonly themes?: WatchThemeSettings | undefined;
  readonly retentionDays?: number | null | undefined;
  readonly replyMilliseconds?: number;
  readonly threadPool?: ThreadPoolSettings;
  readonly port: number;
  readonly announce: (text: string) => void;
  readonly complain: (text: string) => void;
  readonly stopped: Promise<void>;
}

export interface WatchSettings extends ServedSettings {
  readonly client: string;
  readonly actions?: string;
  readonly pullRequests?: WatchPrSettings;
  readonly runtimeDirectory: string;
}

export interface WorkspaceWatchSettings extends ServedSettings {
  readonly repositories: readonly WatchMember[];
}

type TranscriptRead = (query: TranscriptQuery) => Promise<ServiceReply>;

interface Watch {
  readonly actions: WatchActions | null;
  readonly settings: ServedSettings;
  readonly runtimeDirectory: string | null;
  readonly pool: ThreadPoolWatch;
  readonly snapshots: WatchSnapshots;
  readonly transcript: TranscriptRead;
}

interface WatchSource {
  readonly actions: WatchActions | null;
  readonly runtimeDirectory: string | null;
  readonly snapshots: WatchSnapshots;
  readonly transcript: TranscriptRead;
}

const forbidden: Reply = { status: 403, type: "text/plain", body: "refused" };
const libraryFile = fileURLToPath(import.meta.resolve("preact"));
const pageChange = (): string => "data: change\n\n";
const artPolicy = "default-src 'none'; style-src 'unsafe-inline'";
async function snapshot(
  watch: Watch,
  runId: string | null,
): Promise<WatchModel> {
  const shown = await watch.snapshots.snapshot(runId);
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

const unknownTurn: ServiceReply = {
  kind: "error",
  error: { code: "unknown-turn", detail: "No service knows this turn." },
};

function transcriptRead(directories: readonly string[]): TranscriptRead {
  return async (query) => {
    const answers = await Promise.all(
      directories.map((directory) =>
        send(directory, { operation: "transcript", parameters: { ...query } }),
      ),
    );
    return (
      answers.find((answer) => answer.kind === "result") ??
      answers.find(
        (answer) =>
          answer.kind === "error" && answer.error.code !== "unknown-turn",
      ) ??
      unknownTurn
    );
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
    transcript: watch.transcript,
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
  if (path === "/phone.json") return phoneReply(watch);
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

async function phoneReply(watch: Watch): Promise<Reply> {
  return {
    status: 200,
    type: "application/json",
    body:
      watch.runtimeDirectory === null
        ? JSON.stringify({ relay: "off" })
        : await phoneRead(watch.runtimeDirectory),
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
  settings: ServedSettings,
  hosted: { readonly pool: ThreadPoolWatch; readonly source: WatchSource },
): Promise<number> {
  const { pool, source } = hosted;
  const watch: Watch = {
    actions: source.actions,
    settings,
    runtimeDirectory: source.runtimeDirectory,
    pool,
    snapshots: source.snapshots,
    transcript: source.transcript,
  };
  const stream: WatchStream = source.snapshots.stream;
  const server = createServer(requestHandler(watch, stream));
  return new Promise((settle) => {
    server.once("error", (error) => {
      source.snapshots.close();
      settings.complain(`watch-not-started: ${error.message}\n`);
      settle(1);
    });
    server.listen(settings.port, "127.0.0.1", () => {
      const bound: unknown = Reflect.get(Object(server.address()), "port");
      settings.announce(`Watch page: http://127.0.0.1:${String(bound)}/\n`);
    });
    const closed = (): void => {
      source.snapshots.close();
      server.close();
      server.closeAllConnections();
      settle(0);
    };
    settings.stopped.then(closed, closed);
  });
}

async function repositorySource(settings: WatchSettings): Promise<WatchSource> {
  return {
    actions:
      settings.actions === "off"
        ? null
        : await watchActions(settings.runtimeDirectory),
    runtimeDirectory: settings.runtimeDirectory,
    snapshots: await watchSnapshots(settings),
    transcript: transcriptRead([settings.runtimeDirectory]),
  };
}

async function workspaceSource(
  settings: WorkspaceWatchSettings,
): Promise<WatchSource> {
  return {
    actions: null,
    runtimeDirectory: null,
    snapshots: await workspaceSnapshots({
      ...settings,
      members: settings.repositories,
    }),
    transcript: transcriptRead(
      settings.repositories.map((member) => member.runtimeDirectory),
    ),
  };
}

async function guarded(
  settings: ServedSettings,
  source: (settings: ServedSettings) => Promise<WatchSource>,
): Promise<number> {
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
    const shown = { ...settings, stopped };
    return await Promise.race([
      source(shown).then((found) => served(shown, { pool, source: found })),
      stall.promise,
    ]);
  } finally {
    pool.stop();
  }
}

export function watchServer(settings: WatchSettings): Promise<number> {
  return guarded(settings, (shown) =>
    repositorySource({ ...settings, ...shown }),
  );
}

export function workspaceWatchServer(
  settings: WorkspaceWatchSettings,
): Promise<number> {
  return guarded(settings, (shown) =>
    workspaceSource({ ...settings, ...shown }),
  );
}
