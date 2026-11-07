export type Gh = (args: readonly string[]) => Promise<string>;

export interface CandidateOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

interface OpenIssue {
  readonly number: number;
  readonly author: string;
  readonly labels: readonly string[];
  readonly createdAt: string;
  readonly comments: number;
}

const triagedLabel = "cloving: triaged";
const passLimit = 4;
const login = /^[A-Za-z\d](?:[A-Za-z\d]|-(?=[A-Za-z\d])){0,38}$/;
const time = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function unexpected(): Error {
  return new Error("gh printed an unexpected response.");
}

function fields(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw unexpected();
  return Object.fromEntries(Object.entries(value));
}

function text(value: unknown): string {
  if (typeof value !== "string") throw unexpected();
  return value;
}

function instant(value: unknown): string {
  const given = text(value);
  if (!time.test(given)) throw unexpected();
  return given;
}

function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw unexpected();
  return value;
}

function isList(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function rowsOf(pages: unknown): readonly Readonly<Record<string, unknown>>[] {
  if (!isList(pages)) throw unexpected();
  return pages.flatMap((page) => {
    if (!isList(page)) throw unexpected();
    return page.map((row) => fields(row));
  });
}

async function pages(
  gh: Gh,
  path: string,
): Promise<readonly Readonly<Record<string, unknown>>[]> {
  const answer = await gh(["api", "--paginate", "--slurp", path]);
  let value: unknown;
  try {
    value = JSON.parse(answer);
  } catch {
    throw unexpected();
  }
  return rowsOf(value);
}

function labelsOf(value: unknown): readonly string[] {
  if (!isList(value)) throw unexpected();
  return value.map((label) => text(fields(label)["name"]));
}

function issueFrom(row: Readonly<Record<string, unknown>>): OpenIssue {
  return {
    number: count(row["number"]),
    author: text(fields(row["user"])["login"]),
    labels: labelsOf(row["labels"]),
    createdAt: instant(row["created_at"]),
    comments: count(row["comments"]),
  };
}

async function lastPost(gh: Gh, issue: OpenIssue): Promise<string> {
  if (issue.comments === 0) return issue.createdAt;
  const comments = await pages(
    gh,
    `repos/{owner}/{repo}/issues/${String(issue.number)}/comments?per_page=100`,
  );
  return comments
    .map((comment) => instant(comment["created_at"]))
    .reduce((latest, time) => (time > latest ? time : latest), issue.createdAt);
}

async function candidates(request: {
  readonly gh: Gh;
  readonly operators: readonly string[];
  readonly quietSince: string;
}): Promise<readonly number[]> {
  const operators = new Set(
    request.operators.map((login) => login.toLowerCase()),
  );
  const waiting = (
    await pages(
      request.gh,
      "repos/{owner}/{repo}/issues?state=open&per_page=100",
    )
  )
    .filter((row) => row["pull_request"] === undefined)
    .map((row) => issueFrom(row))
    .filter(
      (issue) =>
        !issue.labels.includes(triagedLabel) &&
        !operators.has(issue.author.toLowerCase()),
    )
    .toSorted((left, right) => left.number - right.number);
  const found: number[] = [];
  for (const issue of waiting) {
    if (found.length === passLimit) break;
    if ((await lastPost(request.gh, issue)) <= request.quietSince)
      found.push(issue.number);
  }
  return found;
}

function ghError(error: unknown): string | undefined {
  return error instanceof Error &&
    "stderr" in error &&
    typeof error.stderr === "string" &&
    error.stderr.trim() !== ""
    ? error.stderr.trim()
    : undefined;
}

function failure(error: unknown): string {
  const stderr = ghError(error);
  if (stderr !== undefined) return `The gh command failed: ${stderr}`;
  return error instanceof Error ? error.message : String(error);
}

function refused(reason: string): CandidateOutput {
  return { stdout: "", stderr: `${reason}\n`, exitCode: 1 };
}

export async function candidateOutput(request: {
  readonly gh: Gh;
  readonly operators: readonly string[];
  readonly quietSince: string;
}): Promise<CandidateOutput> {
  if (
    request.operators.length === 0 ||
    !request.operators.every((operator) => login.test(operator))
  )
    return refused("Give the GitHub logins of the operators as arguments.");
  try {
    const found = await candidates(request);
    return {
      stdout: `${JSON.stringify(found.map((number) => ({ number })))}\n`,
      stderr: "",
      exitCode: 0,
    };
  } catch (error) {
    return refused(failure(error));
  }
}
