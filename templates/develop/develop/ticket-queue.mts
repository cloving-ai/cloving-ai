import { blockersOf } from "./feed-selection.ts";
export { blockersOf } from "./feed-selection.ts";

export interface ReadyTicket {
  readonly id: string;
  readonly readyAt: string;
}

export type Gh = (args: readonly string[]) => Promise<string>;

export interface TicketOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

interface Issue {
  readonly number: number;
  readonly open: boolean;
  readonly createdAt: string;
  readonly closedAt: string | null;
  readonly blockers: readonly number[];
}

async function read(gh: Gh, args: readonly string[]): Promise<unknown> {
  return JSON.parse(await gh(args));
}

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

function issueNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw unexpected();
  return value;
}

function isOpen(state: unknown): boolean {
  if (state !== "open" && state !== "closed") throw unexpected();
  return state === "open";
}

function issueFrom(
  issue: Readonly<Record<string, unknown>>,
  number: number,
): Issue {
  return {
    number,
    open: isOpen(issue["state"]),
    createdAt: text(issue["created_at"]),
    closedAt:
      typeof issue["closed_at"] === "string" ? issue["closed_at"] : null,
    blockers: blockersOf(
      typeof issue["body"] === "string" ? issue["body"] : "",
    ),
  };
}

function isList(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function rowsOf(pages: unknown): readonly unknown[] {
  if (!isList(pages)) throw unexpected();
  return pages.flatMap((page) => {
    if (!isList(page)) throw unexpected();
    return page;
  });
}

async function readyIssues(gh: Gh): Promise<readonly Issue[]> {
  const pages = await read(gh, [
    "api",
    "--paginate",
    "--slurp",
    "repos/{owner}/{repo}/issues?state=open&labels=cloving%3A%20ready&per_page=100",
  ]);
  return rowsOf(pages)
    .map((row) => fields(row))
    .filter((issue) => issue["pull_request"] === undefined)
    .map((issue) => issueFrom(issue, issueNumber(issue["number"])))
    .toSorted(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.number - right.number,
    );
}

function ghError(error: unknown): string | undefined {
  return error instanceof Error &&
    "stderr" in error &&
    typeof error.stderr === "string" &&
    error.stderr.trim() !== ""
    ? error.stderr.trim()
    : undefined;
}

async function issueOf(gh: Gh, number: number): Promise<Issue | null> {
  const response = await read(gh, [
    "api",
    `repos/{owner}/{repo}/issues/${String(number)}`,
  ]).catch((error: unknown) => {
    if (/\(HTTP (?:404|410)\)/.test(ghError(error) ?? "")) return null;
    throw error;
  });
  if (response === null) return null;
  return issueFrom(fields(response), number);
}

async function issuesOf(
  gh: Gh,
  numbers: readonly number[],
): Promise<readonly (Issue | null)[]> {
  const result: (Issue | null)[] = [];
  for (let offset = 0; offset < numbers.length; offset += 8)
    result.push(
      ...(await Promise.all(
        numbers.slice(offset, offset + 8).map((number) => issueOf(gh, number)),
      )),
    );
  return result;
}

async function blockerGraph(
  gh: Gh,
  ready: readonly Issue[],
): Promise<ReadonlyMap<number, Issue | null>> {
  const known = new Map<number, Issue | null>(
    ready.map((issue) => [issue.number, issue]),
  );
  let open = ready;
  while (open.length > 0) {
    const unknown = [
      ...new Set(open.flatMap((issue) => issue.blockers)),
    ].filter((number) => !known.has(number));
    const issues = await issuesOf(gh, unknown);
    unknown.forEach((number, index) =>
      known.set(number, issues[index] ?? null),
    );
    open = openIssues(issues);
  }
  return known;
}

function openIssues(issues: Iterable<Issue | null>): readonly Issue[] {
  return [...issues].filter((issue): issue is Issue => issue?.open === true);
}

function openBlockers(
  known: ReadonlyMap<number, Issue | null>,
  number: number,
): readonly number[] {
  return (known.get(number)?.blockers ?? []).filter(
    (blocker) => known.get(blocker)?.open === true,
  );
}

function cycleThrough(
  known: ReadonlyMap<number, Issue | null>,
  start: number,
): readonly number[] | undefined {
  const paths = new Map<number, readonly number[]>([[start, [start]]]);
  const queue = [start];
  for (const number of queue) {
    const path = paths.get(number) ?? [];
    for (const blocker of openBlockers(known, number)) {
      if (blocker === start) return [...path, start];
      if (paths.has(blocker)) continue;
      paths.set(blocker, [...path, blocker]);
      queue.push(blocker);
    }
  }
  return undefined;
}

function cycles(
  known: ReadonlyMap<number, Issue | null>,
): readonly (readonly number[])[] {
  const named = new Set<number>();
  const found: (readonly number[])[] = [];
  for (const issue of openIssues(known.values())) {
    if (named.has(issue.number)) continue;
    const cycle = cycleThrough(known, issue.number);
    if (cycle === undefined) continue;
    for (const number of cycle) named.add(number);
    found.push(cycle);
  }
  return found;
}

async function readyTickets(input: {
  readonly gh: Gh;
  readonly warn: (line: string) => void;
}): Promise<readonly ReadyTicket[]> {
  const { gh, warn } = input;
  const ready = await readyIssues(gh);
  const known = await blockerGraph(gh, ready);
  for (const cycle of cycles(known))
    warn(
      `Dependency cycle: ${cycle.map((number) => `#${String(number)}`).join(" -> ")}`,
    );
  for (const issue of openIssues(known.values()))
    for (const blocker of issue.blockers)
      if (known.get(blocker) === null)
        warn(
          `Missing blocker: #${String(issue.number)} needs #${String(blocker)}, which does not exist`,
        );
  return ready
    .filter((issue) =>
      issue.blockers.every((blocker) => known.get(blocker)?.open === false),
    )
    .map((issue) => ({
      id: String(issue.number),
      readyAt: issue.blockers.reduce((latest, blocker) => {
        const closedAt = known.get(blocker)?.closedAt ?? latest;
        return closedAt > latest ? closedAt : latest;
      }, issue.createdAt),
    }));
}

function failure(error: unknown): string {
  const stderr = ghError(error);
  if (stderr !== undefined) return `The gh command failed: ${stderr}`;
  return error instanceof Error ? error.message.trim() : String(error);
}

export async function ticketOutput(input: {
  readonly gh: Gh;
  readonly format: (tickets: readonly ReadyTicket[]) => string;
}): Promise<TicketOutput> {
  const lines: string[] = [];
  const warn = (line: string): void => {
    lines.push(`${line}\n`);
  };
  try {
    const tickets = await readyTickets({ gh: input.gh, warn });
    return {
      stdout: input.format(tickets),
      stderr: lines.join(""),
      exitCode: 0,
    };
  } catch (error) {
    warn(failure(error));
    return { stdout: "", stderr: lines.join(""), exitCode: 1 };
  }
}
