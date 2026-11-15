import { field, repositoryPath, type Operation } from "./github-operation.ts";

export interface ListedIssue {
  readonly number: number;
  readonly url: string;
  readonly title: string;
  readonly body: string;
  readonly createdAt: string;
  readonly labels: readonly string[];
  readonly bodyOmitted?: "result-too-large" | "body-limit";
  readonly bodyEncoding?: "base64";
}

interface IssueQuery {
  readonly search: string;
  readonly limit: number;
  readonly cursor: number | undefined;
  readonly maximumBodyBytes: number | undefined;
}

const pageSize = 100;
const pageLimit = 10;
const states: ReadonlySet<string> = new Set(["open", "closed", "all"]);

function textOf(value: unknown): string {
  if (typeof value !== "string") throw new Error("github-call-failed");
  return value;
}

function issueNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new Error("github-call-failed");
  return value;
}

function listedIssue(row: unknown): ListedIssue {
  const body = field(row, "body");
  const labels = field(row, "labels");
  if (!Array.isArray(labels)) throw new Error("github-call-failed");
  return {
    number: issueNumber(field(row, "number")),
    url: textOf(field(row, "html_url")),
    title: textOf(field(row, "title")),
    body: body === null ? "" : textOf(body),
    createdAt: textOf(field(row, "created_at")),
    labels: labels.map((label: unknown) => textOf(field(label, "name"))),
  };
}

function refused(): never {
  throw new Error("invalid-github-input");
}

function labelName(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "" || value.includes(","))
    refused();
  return value;
}

function wholeLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) refused();
  if (value < 1 || value > 100) refused();
  return value;
}

function cursorOf(payload: Operation["payload"]): number | undefined {
  if (!Object.hasOwn(payload, "cursor")) return undefined;
  const cursor = payload["cursor"];
  if (
    typeof cursor !== "number" ||
    !Number.isSafeInteger(cursor) ||
    cursor < 0 ||
    cursor > 999
  )
    refused();
  return cursor;
}

function bodyLimitOf(payload: Operation["payload"]): number | undefined {
  if (!Object.hasOwn(payload, "maximumBodyBytes")) return undefined;
  const value = payload["maximumBodyBytes"];
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > 262144
  )
    refused();
  return value;
}

function issueQuery(payload: Operation["payload"]): IssueQuery {
  const { labels, state, limit } = payload;
  const keys = Object.keys(payload).toSorted().join(",");
  if (
    keys !== "labels,limit,state" &&
    keys !== "cursor,labels,limit,state" &&
    keys !== "cursor,labels,limit,maximumBodyBytes,state"
  )
    refused();
  const start = cursorOf(payload);
  if (!Array.isArray(labels) || labels.length > 5) refused();
  if (typeof state !== "string" || !states.has(state)) refused();
  const filter = labels.map((label: unknown) =>
    encodeURIComponent(labelName(label)),
  );
  return {
    search: [
      `state=${state}`,
      ...(filter.length === 0 ? [] : [`labels=${filter.join(",")}`]),
      `sort=created&direction=desc&per_page=${String(start === undefined ? pageSize : 10)}`,
    ].join("&"),
    limit: wholeLimit(limit),
    cursor: start,
    maximumBodyBytes: bodyLimitOf(payload),
  };
}

async function pageRows(
  operation: Operation,
  request: { readonly search: string; readonly page: number },
): Promise<readonly unknown[]> {
  const rows: unknown = JSON.parse(
    await operation.calls.gh([
      "api",
      `${repositoryPath}/issues?${request.search}&page=${String(request.page)}`,
    ]),
  );
  if (!Array.isArray(rows)) throw new Error("github-call-failed");
  return rows.map((row: unknown) => row);
}

async function issuePage(
  operation: Operation,
  request: { readonly search: string; readonly page: number },
) {
  const rows = await pageRows(operation, request);
  return {
    issues: rows
      .filter((row: unknown) => field(row, "pull_request") === undefined)
      .map((row: unknown) => listedIssue(row)),
    full: rows.length >= pageSize,
  };
}

export async function listIssues(operation: Operation) {
  const query = issueQuery(operation.payload);
  if (query.cursor !== undefined) return cursorPage(operation, query);
  const { search, limit } = query;
  const found = new Map<number, ListedIssue>();
  for (let page = 1; found.size < limit; page++) {
    if (page > pageLimit) throw new Error("issues-limit");
    const read = await issuePage(operation, { search, page });
    for (const issue of read.issues) found.set(issue.number, issue);
    if (!read.full) break;
  }
  return [...found.values()].slice(0, limit);
}

interface CursorPage {
  readonly issues: ListedIssue[];
  readonly cursor: number | null;
}

function pageBytes(page: CursorPage): number {
  return Buffer.byteLength(JSON.stringify(page));
}

function boundedIssue(issue: ListedIssue): ListedIssue {
  if (pageBytes({ issues: [issue], cursor: 1000 }) <= 262144) return issue;
  const omitted = {
    ...issue,
    body: "",
    bodyOmitted: "result-too-large" as const,
  };
  if (pageBytes({ issues: [omitted], cursor: 1000 }) > 262144)
    throw new Error("result-too-large");
  return omitted;
}

function encodedIssue(
  issue: ListedIssue,
  maximumBodyBytes: number | undefined,
): ListedIssue {
  if (
    maximumBodyBytes !== undefined &&
    Buffer.byteLength(issue.body) > maximumBodyBytes
  )
    return boundedIssue({ ...issue, body: "", bodyOmitted: "body-limit" });
  const bytes = Buffer.from(issue.body);
  if (bytes.toString("utf8") !== issue.body)
    throw new Error("github-call-failed");
  const encoded = {
    ...issue,
    body: bytes.toString("base64"),
    bodyEncoding: "base64" as const,
  };
  const smaller =
    pageBytes({ issues: [encoded], cursor: 1000 }) <
    pageBytes({ issues: [issue], cursor: 1000 })
      ? encoded
      : issue;
  return boundedIssue(smaller);
}

async function cursorPage(
  operation: Operation,
  query: IssueQuery,
): Promise<CursorPage> {
  let cursor = query.cursor ?? 0;
  const issues: ListedIssue[] = [];
  while (cursor < 1000) {
    const page = Math.floor(cursor / 10) + 1;
    const rows = await pageRows(operation, { search: query.search, page });
    const index = appendRows(rows, { issues, start: cursor % 10, query });
    cursor = (page - 1) * 10 + index;
    if (index >= rows.length && rows.length < 10)
      return { issues, cursor: null };
    if (index < rows.length || issues.length >= query.limit)
      return { issues, cursor };
  }
  return { issues, cursor };
}

function appendRows(
  rows: readonly unknown[],
  context: {
    readonly issues: ListedIssue[];
    readonly start: number;
    readonly query: IssueQuery;
  },
): number {
  const { issues, start, query } = context;
  let index = start;
  for (; index < rows.length && issues.length < query.limit; index++) {
    const row = rows[index];
    if (field(row, "pull_request") !== undefined) continue;
    const issue = encodedIssue(listedIssue(row), query.maximumBodyBytes);
    if (pageBytes({ issues: [...issues, issue], cursor: 1000 }) > 262144) break;
    issues.push(issue);
  }
  return index;
}
