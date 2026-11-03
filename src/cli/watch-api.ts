import { STATUS_CODES } from "node:http";
import { runStates, watchApiDocument } from "./watch-api-document.ts";
import type { WatchModel, WatchRun, WatchWorkflow } from "./watch-render.ts";
import type { CardField } from "./watch-run-input.ts";

export interface ApiReply {
  readonly status: number;
  readonly type: string;
  readonly body: string;
  readonly allow?: string;
}

export interface ApiRequest {
  readonly method: string;
  readonly url: URL;
  readonly model: () => Promise<WatchModel>;
}

const base = "/api/v1";
const defaultLimit = 50;

function found(value: unknown): ApiReply {
  return { status: 200, type: "application/json", body: JSON.stringify(value) };
}

function problem(
  status: number,
  detail: { readonly code: string; readonly detail: string },
): ApiReply {
  return {
    status,
    type: "application/problem+json",
    body: JSON.stringify({
      type: "about:blank",
      title: STATUS_CODES[status],
      status,
      detail: detail.detail,
      code: detail.code,
    }),
  };
}

const serviceUnavailable = problem(503, {
  code: "service-unavailable",
  detail: "The Cloving service does not answer.",
});

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
): unknown {
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

function runOf(run: WatchRun): unknown {
  const { pullRequest, currentStep } = run;
  return {
    runId: run.runId,
    workflowId: run.workflowId,
    ticketId: run.ticketId,
    title: run.title,
    state: run.state,
    outcome: run.outcome,
    currentStep: { name: currentStep.name, startedAt: currentStep.startedAt },
    latestAt: run.latestAt,
    pullRequest:
      pullRequest === null
        ? null
        : { number: pullRequest.number, url: pullRequest.url },
    estimatedCostUsd: run.estimatedCostUsd,
  };
}

function instant(latestAt: string | null): number {
  const time = Date.parse(latestAt ?? "");
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}

function codeOrder(first: string, second: string): number {
  if (first === second) return 0;
  return first < second ? -1 : 1;
}

interface RunKey {
  readonly latestAt: string | null;
  readonly runId: string;
}

function runOrder(first: RunKey, second: RunKey): number {
  const earlier = instant(first.latestAt);
  const later = instant(second.latestAt);
  if (earlier !== later) return earlier > later ? -1 : 1;
  return codeOrder(first.runId, second.runId);
}

function cursorOf(run: RunKey): string {
  return Buffer.from(JSON.stringify([run.latestAt, run.runId])).toString(
    "base64url",
  );
}

function parsedJson(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    return null;
  }
}

function keyOf(cursor: string): RunKey | null {
  const value = parsedJson(Buffer.from(cursor, "base64url").toString("utf8"));
  const entries = Array.isArray(value)
    ? value.map((item: unknown) => item)
    : [];
  const [latestAt, runId] = entries;
  if (entries.length !== 2 || typeof runId !== "string") return null;
  if (latestAt !== null && typeof latestAt !== "string") return null;
  const key = { latestAt, runId };
  return cursorOf(key) === cursor ? key : null;
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
    limit: Number(searchParams.get("limit") ?? defaultLimit),
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

type Parameters = ReadonlyMap<string, (value: string) => boolean>;

interface Route {
  readonly parameters: Parameters;
  readonly reply: (request: ApiRequest) => Promise<ApiReply>;
}

const runParameters: Parameters = new Map([
  ["workflowId", (value: string) => value !== ""],
  ["state", (value: string) => runStates.some((state) => state === value)],
  [
    "limit",
    (value: string) => /^[1-9]\d*$/.test(value) && Number(value) <= 200,
  ],
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
]);

export const watchApiPaths: readonly string[] = [...routes.keys()];

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
): Promise<ApiReply | null> {
  const { pathname } = request.url;
  if (pathname !== base && !pathname.startsWith(`${base}/`)) return null;
  if (request.method !== "GET")
    return {
      ...problem(405, {
        code: "method-not-allowed",
        detail: "The API accepts only GET.",
      }),
      allow: "GET",
    };
  const route = routes.get(pathname.slice(base.length) || "/");
  if (route === undefined)
    return problem(404, {
      code: "not-found",
      detail: "The API has no resource at this path.",
    });
  const refused = refusedParameter(request.url, route.parameters);
  if (refused !== null)
    return problem(400, {
      code: "invalid-query",
      detail: `The query parameter ${refused} is unknown, repeated or has an invalid value.`,
    });
  return route.reply(request);
}
