import { field, repositoryPath, type Operation } from "./github-operation.ts";

export interface ListedIssue {
  readonly number: number;
  readonly url: string;
  readonly title: string;
  readonly body: string;
  readonly createdAt: string;
  readonly labels: readonly string[];
}

interface IssueQuery {
  readonly search: string;
  readonly limit: number;
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

function issueQuery(payload: Operation["payload"]): IssueQuery {
  const { labels, state, limit } = payload;
  if (Object.keys(payload).toSorted().join(",") !== "labels,limit,state")
    refused();
  if (!Array.isArray(labels) || labels.length > 5) refused();
  if (typeof state !== "string" || !states.has(state)) refused();
  const filter = labels.map((label: unknown) =>
    encodeURIComponent(labelName(label)),
  );
  return {
    search: [
      `state=${state}`,
      ...(filter.length === 0 ? [] : [`labels=${filter.join(",")}`]),
      `sort=created&direction=desc&per_page=${String(pageSize)}`,
    ].join("&"),
    limit: wholeLimit(limit),
  };
}

async function issuePage(
  operation: Operation,
  request: { readonly search: string; readonly page: number },
): Promise<{
  readonly issues: readonly ListedIssue[];
  readonly full: boolean;
}> {
  const rows: unknown = JSON.parse(
    await operation.calls.gh([
      "api",
      `${repositoryPath}/issues?${request.search}&page=${String(request.page)}`,
    ]),
  );
  if (!Array.isArray(rows)) throw new Error("github-call-failed");
  return {
    issues: rows
      .filter((row: unknown) => field(row, "pull_request") === undefined)
      .map((row: unknown) => listedIssue(row)),
    full: rows.length >= pageSize,
  };
}

export async function listIssues(
  operation: Operation,
): Promise<readonly ListedIssue[]> {
  const { search, limit } = issueQuery(operation.payload);
  const found = new Map<number, ListedIssue>();
  for (let page = 1; found.size < limit; page++) {
    if (page > pageLimit) throw new Error("issues-limit");
    const read = await issuePage(operation, { search, page });
    for (const issue of read.issues) found.set(issue.number, issue);
    if (!read.full) break;
  }
  return [...found.values()].slice(0, limit);
}
