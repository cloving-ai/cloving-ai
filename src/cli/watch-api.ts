import { runLimit, runStates, watchApiDocument } from "./watch-api-document.ts";
import type {
  WatchEvent,
  WatchModel,
  WatchRun,
  WatchWorkflow,
} from "./watch-render.ts";
import type { CardField } from "./watch-run-input.ts";
import {
  cursorOf,
  eventsAfter,
  keyOf,
  runDetailOf,
  runOf,
  runOrder,
  type ApiRun,
  type ApiRunDetail,
  type RunKey,
} from "./watch-api-run.ts";
import {
  problem,
  serviceUnavailable,
  type ApiReply,
} from "./watch-api-problem.ts";
import {
  transcriptReply,
  transcriptStreamReply,
  type TranscriptFeed,
  type TranscriptRequest,
} from "./watch-api-transcript.ts";

export interface ApiRequest extends TranscriptRequest {
  readonly method: string;
  readonly model: () => Promise<WatchModel>;
  readonly run: (runId: string) => Promise<WatchModel>;
}

export type ApiAnswer = ApiReply | "stream" | TranscriptFeed;

interface ApiIndex {
  readonly version: 1;
  readonly openapi: string;
  readonly endpoints: readonly {
    readonly method: "GET";
    readonly path: string;
    readonly operationId: string;
  }[];
}

interface ApiService {
  readonly up: boolean;
  readonly updatedAt: string;
}

interface ApiWorkflow {
  readonly workflowId: string;
  readonly activeCount: number;
  readonly waitingCount: number;
  readonly latestAt: string | null;
  readonly inputs: readonly CardField[];
}

type ApiBody =
  | typeof watchApiDocument
  | ApiIndex
  | ApiService
  | { readonly workflows: readonly ApiWorkflow[] }
  | { readonly runs: readonly ApiRun[]; readonly nextCursor: string | null }
  | { readonly run: ApiRunDetail }
  | { readonly events: readonly WatchEvent[] };

const base = "/api/v1";

function found(body: ApiBody): ApiReply {
  return { status: 200, type: "application/json", body: JSON.stringify(body) };
}

const unknownRun = problem(404, {
  code: "not-found",
  detail: "The service has no run with this ID.",
});

const timeout = problem(503, {
  code: "timeout",
  detail: "The watch page did not complete the reply before the deadline.",
});

function inApi(pathname: string): boolean {
  return pathname === base || pathname.startsWith(`${base}/`);
}

export function watchApiTimeout(pathname: string): ApiReply | null {
  return inApi(pathname) ? timeout : null;
}

function apiIndex(): ApiReply {
  return found({
    version: 1,
    openapi: `${base}/openapi.json`,
    endpoints: Object.entries(watchApiDocument.paths).map(([path, item]) => ({
      method: "GET",
      path: `${base}${path}`,
      operationId: item.get.operationId,
    })),
  });
}

async function service(request: ApiRequest): Promise<ApiReply> {
  const model = await request.model();
  return found({ up: model.service === "up", updatedAt: model.updatedAt });
}

function inputOf(field: CardField): CardField {
  return {
    name: field.name,
    label: field.label,
    multiline: field.multiline,
    optional: field.optional,
  };
}

function workflowOf(
  workflow: WatchWorkflow,
  forms: WatchModel["cardForms"],
): ApiWorkflow {
  const form = forms?.find((item) => item.workflowId === workflow.workflowId);
  return {
    workflowId: workflow.workflowId,
    activeCount: workflow.activeCount,
    waitingCount: workflow.waitingCount,
    latestAt: workflow.latestAt,
    inputs: (form?.fields ?? []).map(inputOf),
  };
}

async function workflows(request: ApiRequest): Promise<ApiReply> {
  const model = await request.model();
  if (model.service !== "up") return serviceUnavailable;
  return found({
    workflows: model.workflows.map((workflow) =>
      workflowOf(workflow, model.cardForms),
    ),
  });
}

interface RunQuery {
  readonly workflowId: string | null;
  readonly state: string | null;
  readonly limit: number;
  readonly after: RunKey | null;
}

function runQuery(url: URL): RunQuery {
  const { searchParams } = url;
  const cursor = searchParams.get("cursor");
  return {
    workflowId: searchParams.get("workflowId"),
    state: searchParams.get("state"),
    limit: Number(searchParams.get("limit") ?? runLimit.default),
    after: cursor === null ? null : keyOf(cursor),
  };
}

function selected(run: WatchRun, query: RunQuery): boolean {
  return (
    (query.workflowId === null || run.workflowId === query.workflowId) &&
    (query.state === null || run.state === query.state) &&
    (query.after === null || runOrder(run, query.after) > 0)
  );
}

async function runs(request: ApiRequest): Promise<ApiReply> {
  const model = await request.model();
  if (model.service !== "up") return serviceUnavailable;
  const query = runQuery(request.url);
  const remaining = model.runs
    .filter((run) => selected(run, query))
    .toSorted(runOrder);
  const page = remaining.slice(0, query.limit);
  const last = page.at(-1);
  return found({
    runs: page.map(runOf),
    nextCursor:
      remaining.length > page.length && last !== undefined
        ? cursorOf(last)
        : null,
  });
}

function wholeNumber(value: string): boolean {
  return /^(0|[1-9]\d*)$/.test(value);
}

function withinLimit(value: string): boolean {
  const limit = Number(value);
  return (
    wholeNumber(value) && limit >= runLimit.minimum && limit <= runLimit.maximum
  );
}

function unanswered(error: unknown): null {
  if (error instanceof Error && error.message === "service-unavailable")
    return null;
  throw error;
}

type PathValues = ReadonlyMap<string, string>;

interface RunRead {
  readonly path: PathValues;
  readonly body: (run: WatchRun) => ApiBody;
}

async function runReply(request: ApiRequest, read: RunRead): Promise<ApiReply> {
  const model = await request
    .run(read.path.get("runId") ?? "")
    .catch(unanswered);
  if (model === null) return serviceUnavailable;
  const [run] = model.runs;
  return run === undefined ? unknownRun : found(read.body(run));
}

function runDetail(request: ApiRequest, path: PathValues): Promise<ApiReply> {
  return runReply(request, {
    path,
    body: (run) => ({ run: runDetailOf(run) }),
  });
}

function runEvents(request: ApiRequest, path: PathValues): Promise<ApiReply> {
  const after = Number(request.url.searchParams.get("after") ?? 0);
  return runReply(request, {
    path,
    body: (run) => ({ events: eventsAfter(run, after) }),
  });
}

type Parameters = ReadonlyMap<string, (value: string) => boolean>;

interface Route {
  readonly parameters: Parameters;
  readonly reply: (request: ApiRequest, path: PathValues) => Promise<ApiAnswer>;
}

const runParameters: Parameters = new Map([
  ["workflowId", (value: string) => value !== ""],
  ["state", (value: string) => runStates.some((state) => state === value)],
  ["limit", withinLimit],
  ["cursor", (value: string) => keyOf(value) !== null],
]);

function fixed(reply: () => ApiReply): Route {
  return { parameters: new Map(), reply: () => Promise.resolve(reply()) };
}

const routes = new Map<string, Route>([
  ["/", fixed(apiIndex)],
  ["/openapi.json", fixed(() => found(watchApiDocument))],
  ["/service", { parameters: new Map(), reply: service }],
  ["/workflows", { parameters: new Map(), reply: workflows }],
  ["/runs", { parameters: runParameters, reply: runs }],
  ["/runs/{runId}", { parameters: new Map(), reply: runDetail }],
  [
    "/runs/{runId}/events",
    { parameters: new Map([["after", wholeNumber]]), reply: runEvents },
  ],
  [
    "/runs/{runId}/turns/{operationId}/transcript",
    { parameters: new Map([["after", wholeNumber]]), reply: transcriptReply },
  ],
  [
    "/runs/{runId}/turns/{operationId}/transcript-stream",
    {
      parameters: new Map([["after", wholeNumber]]),
      reply: transcriptStreamReply,
    },
  ],
  [
    "/stream",
    { parameters: new Map(), reply: () => Promise.resolve("stream") },
  ],
]);

export const watchApiPaths: readonly string[] = [...routes.keys()];

export function watchApiChange(): string {
  const change = { updatedAt: new Date().toISOString() };
  return `event: change\ndata: ${JSON.stringify(change)}\n\n`;
}

const placeholder = /^\{(\w+)\}$/;

function decoded(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return "";
  }
}

function matchedPath(template: string, path: string): PathValues | null {
  const parts = template.split("/");
  const segments = path.split("/");
  if (parts.length !== segments.length) return null;
  const pairs = parts.map(
    (part, index) => [part, segments[index] ?? ""] as const,
  );
  if (
    pairs.some(([part, segment]) => !placeholder.test(part) && part !== segment)
  )
    return null;
  const values = pairs.flatMap(([part, segment]) => {
    const name = placeholder.exec(part)?.[1];
    return name === undefined ? [] : [[name, decoded(segment)] as const];
  });
  if (values.some(([, value]) => value === "")) return null;
  return new Map(values);
}

function routeOf(
  path: string,
): { readonly route: Route; readonly values: PathValues } | null {
  for (const [template, route] of routes) {
    const values = matchedPath(template, path);
    if (values !== null) return { route, values };
  }
  return null;
}

function refusedParameter(url: URL, parameters: Parameters): string | null {
  const names = [...url.searchParams.keys()];
  const refused = names.find(
    (name, index) =>
      names.indexOf(name) !== index ||
      parameters.get(name)?.(url.searchParams.get(name) ?? "") !== true,
  );
  return refused ?? null;
}

export async function watchApiReply(
  request: ApiRequest,
): Promise<ApiAnswer | null> {
  const { pathname } = request.url;
  if (!inApi(pathname)) return null;
  if (request.method !== "GET")
    return {
      ...problem(405, {
        code: "method-not-allowed",
        detail: "The API accepts only GET.",
      }),
      allow: "GET",
    };
  const matched = routeOf(pathname.slice(base.length) || "/");
  if (matched === null)
    return problem(404, {
      code: "not-found",
      detail: "The API has no resource at this path.",
    });
  const refused = refusedParameter(request.url, matched.route.parameters);
  if (refused !== null)
    return problem(400, {
      code: "invalid-query",
      detail: `The query parameter ${refused} is unknown, repeated or has an invalid value.`,
    });
  return matched.route.reply(request, matched.values);
}
