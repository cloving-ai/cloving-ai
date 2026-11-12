import { record, type Fields, type Reply } from "../protocol.ts";
import type { TranscriptEntry } from "../turn-transcript.ts";
import { transcriptKinds } from "./watch-api-document.ts";
import {
  problem,
  serviceUnavailable,
  type ApiReply,
} from "./watch-api-problem.ts";

export interface TranscriptQuery {
  readonly before?: number;
  readonly runId: string;
  readonly operationId: string;
  readonly after: number;
}

export interface TranscriptRequest {
  readonly url: URL;
  readonly lastEventId: string | null;
  readonly transcript: (query: TranscriptQuery) => Promise<Reply>;
}

export interface ApiTranscriptPage {
  readonly hasEarlier?: boolean;
  readonly entries: readonly TranscriptEntry[];
  readonly nextAfter: number;
  readonly open: boolean;
}

export interface TranscriptFeed {
  readonly kind: "transcript-stream";
  readonly first: ApiTranscriptPage;
  readonly read: (
    after: number,
  ) => Promise<ApiTranscriptPage | ApiReply | null>;
}

type PathValues = ReadonlyMap<string, string>;

const transcriptUnavailable = problem(503, {
  code: "transcript-unavailable",
  detail: "The Cloving service gives no transcripts.",
});

const refusals = new Map<string, ApiReply>([
  [
    "unknown-turn",
    problem(404, {
      code: "not-found",
      detail: "The run has no agent turn with this operation ID.",
    }),
  ],
  [
    "transcript-not-kept",
    problem(410, {
      code: "transcript-not-kept",
      detail: "The transcript of this turn is not kept.",
    }),
  ],
  ["transcript-unavailable", transcriptUnavailable],
  ["unknown-operation", transcriptUnavailable],
]);

const invalidHeader = problem(400, {
  code: "invalid-last-event-id",
  detail: "The Last-Event-ID header must be a whole number.",
});

function count(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : 0;
}

function words(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function entryOf(value: unknown): TranscriptEntry {
  const item = record(value) ?? {};
  return {
    ...(typeof item["replaceId"] === "string"
      ? { replaceId: item["replaceId"] }
      : {}),
    ...(item["removed"] === true ? { removed: true } : {}),
    position: count(item["position"]),
    attempt: count(item["attempt"]),
    kind: transcriptKinds.find((kind) => kind === item["kind"]) ?? "notice",
    text: words(item["text"]),
    tool: typeof item["tool"] === "string" ? item["tool"] : null,
    callId: typeof item["callId"] === "string" ? item["callId"] : null,
    summary: words(item["summary"]),
    error: item["error"] === true,
    omittedBytes: count(item["omittedBytes"]),
  };
}

function pageOf(result: Fields): ApiTranscriptPage | null {
  const { entries, nextAfter, open } = result;
  if (!Array.isArray(entries) || typeof open !== "boolean") return null;
  if (typeof nextAfter !== "number" || !Number.isSafeInteger(nextAfter))
    return null;
  return {
    entries: entries.map(entryOf),
    nextAfter,
    open,
    ...(typeof result["hasEarlier"] === "boolean"
      ? { hasEarlier: result["hasEarlier"] }
      : {}),
  };
}

async function pageRead(
  request: TranscriptRequest,
  query: TranscriptQuery,
): Promise<ApiTranscriptPage | ApiReply> {
  const reply = await request.transcript(query);
  if (reply.kind === "error")
    return refusals.get(reply.error.code) ?? serviceUnavailable;
  return pageOf(reply.result) ?? serviceUnavailable;
}

function isPage(
  value: ApiTranscriptPage | ApiReply,
): value is ApiTranscriptPage {
  return "entries" in value;
}

function queryOf(path: PathValues, after: number): TranscriptQuery {
  return {
    runId: path.get("runId") ?? "",
    operationId: path.get("operationId") ?? "",
    after,
  };
}

function afterOf(request: TranscriptRequest): number {
  return Number(request.url.searchParams.get("after") ?? 0);
}

export async function transcriptReply(
  request: TranscriptRequest,
  path: PathValues,
): Promise<ApiReply> {
  const before = request.url.searchParams.get("before");
  const page = await pageRead(request, {
    ...queryOf(path, afterOf(request)),
    ...(before === null ? {} : { before: Number(before) }),
  });
  if (!isPage(page)) return page;
  return { status: 200, type: "application/json", body: JSON.stringify(page) };
}

export async function transcriptStreamReply(
  request: TranscriptRequest,
  path: PathValues,
): Promise<ApiReply | TranscriptFeed> {
  const resumed = request.lastEventId;
  if (resumed !== null && !/^(0|[1-9]\d*)$/.test(resumed)) return invalidHeader;
  const after = resumed === null ? afterOf(request) : Number(resumed);
  const first = await pageRead(request, queryOf(path, after));
  if (!isPage(first)) return first;
  return {
    kind: "transcript-stream",
    first,
    read: async (next) => {
      const page = await pageRead(request, queryOf(path, next));
      if (isPage(page) || page.status < 500) return page;
      return null;
    },
  };
}
