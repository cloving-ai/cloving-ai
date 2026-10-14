import { readdir, readFile, stat } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Fields, ServiceRequest } from "../protocol.ts";
import { send } from "./client.ts";
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
  readonly details: Map<string, { sequence: unknown; value: unknown }>;
  readonly streams: Map<string, { size: number; lines: readonly string[] }>;
}

const notFound: Reply = { status: 404, type: "text/plain", body: "not found" };
const libraryFile = fileURLToPath(import.meta.resolve("preact"));
const shownRuns = 12;

function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value.map((item: unknown) => item) : [];
}

function parsed(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    return null;
  }
}

async function asked(watch: Watch, request: ServiceRequest): Promise<Fields> {
  const reply = await send(watch.settings.runtimeDirectory, request);
  return reply.kind === "error" ? {} : reply.result;
}

async function detailed(watch: Watch, run: unknown): Promise<unknown> {
  const runId = String(Reflect.get(Object(run), "runId"));
  const sequence: unknown = Reflect.get(Object(run), "latestSequence");
  const known = watch.details.get(runId);
  if (known !== undefined && known.sequence === sequence) return known.value;
  const shown = await asked(watch, {
    operation: "status",
    parameters: { runId },
  });
  const events = await asked(watch, {
    operation: "events",
    parameters: { runId, after: 0, limit: 1000 },
  });
  const value = { status: shown["run"], events: events["events"] };
  watch.details.set(runId, { sequence, value });
  return value;
}

async function service(watch: Watch): Promise<{
  readonly service: string;
  readonly runs: readonly unknown[];
  readonly decisions: readonly unknown[];
}> {
  const status = await asked(watch, { operation: "status", parameters: {} });
  if (!Array.isArray(status["runs"]))
    return { service: "down", runs: [], decisions: [] };
  const runs: unknown[] = [];
  for (const run of list(status["runs"]).slice(-shownRuns))
    runs.push(await detailed(watch, run));
  const questions = await asked(watch, {
    operation: "questions",
    parameters: {},
  });
  return { service: "up", runs, decisions: list(questions["decisions"]) };
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
  const found: GithubRecords[] = [];
  for (const key of await readdir(journal).catch(() => [])) {
    const started = await stored(join(journal, key, "started.json"));
    if (started === null) continue;
    const result = await stored(join(journal, key, "result.json"));
    found.push({ started, result });
  }
  return found;
}

async function snapshot(watch: Watch): Promise<WatchModel> {
  const [read, journal, github] = await Promise.all([
    service(watch),
    turns(watch),
    githubRecords(watch),
  ]);
  return watchModel({
    ...read,
    host: dirname(watch.settings.runtimeDirectory),
    client: watch.settings.client,
    updatedAt: new Date().toISOString(),
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
  const path = new URL(String(request.url), "http://localhost").pathname;
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
  return {
    status: 200,
    type: "application/json",
    body: JSON.stringify(await snapshot(watch)),
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
  const watch: Watch = { settings, details: new Map(), streams: new Map() };
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
