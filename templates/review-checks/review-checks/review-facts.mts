export interface CommandCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly github: boolean;
}

export interface FactsSystem {
  readonly commandArguments: readonly string[];
  readonly since: string;
  readonly run: (call: CommandCall) => Promise<string>;
  readonly decisions: () => Promise<string>;
  readonly qualityChecks: () => Promise<readonly string[]>;
}

export interface ScriptOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

type Row = Readonly<Record<string, unknown>>;
type Severity = "off" | "warn" | "error";

interface ReviewComment {
  readonly pullRequest: number;
  readonly path: string;
  readonly line: number | null;
  readonly author: string;
  readonly bot: boolean;
  readonly text: string;
  readonly url: string;
}

const usage =
  "Give the absolute GitHub CLI configuration folder and the absolute decisions file as the two arguments.";
const checkIssues =
  "repos/{owner}/{repo}/issues?state=open&labels=cloving%3A%20check&per_page=100";
const commentLimit = 200;
const lintFileLimit = 10;
const severities: readonly Severity[] = ["off", "warn", "error"];

function unexpected(source: string): Error {
  return new Error(`${source} printed an unexpected response.`);
}

function rowOf(value: unknown, source: string): Row {
  if (typeof value === "object" && value !== null && !Array.isArray(value))
    return Object.fromEntries(Object.entries(value));
  throw unexpected(source);
}

function isList(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function parsedJson(text: string, source: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    throw unexpected(source);
  }
}

function pagedRows(text: string): readonly Row[] {
  const pages = parsedJson(text, "gh");
  if (!isList(pages)) throw unexpected("gh");
  return pages.flatMap((page) => {
    if (!isList(page)) throw unexpected("gh");
    return page.map((row) => rowOf(row, "gh"));
  });
}

function stringOf(value: unknown, source: string): string {
  if (typeof value === "string") return value;
  throw unexpected(source);
}

function numberOf(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0)
    return value;
  throw unexpected("gh");
}

function lineOf(row: Row): number | null {
  const line = row["line"] ?? row["original_line"] ?? null;
  return line === null ? null : numberOf(line);
}

function github(system: FactsSystem, args: readonly string[]) {
  return system.run({ command: "gh", args, github: true });
}

async function mergedPulls(system: FactsSystem): Promise<readonly number[]> {
  const listed = parsedJson(
    await github(system, [
      "pr",
      "list",
      "--state",
      "merged",
      "--search",
      `merged:>=${system.since.slice(0, 10)}`,
      "--json",
      "number,url,mergedAt",
      "--limit",
      "1000",
    ]),
    "gh",
  );
  if (!isList(listed)) throw unexpected("gh");
  return listed
    .map((item) => rowOf(item, "gh"))
    .filter((row) => stringOf(row["mergedAt"], "gh") >= system.since)
    .map((row) => numberOf(row["number"]))
    .sort((left, right) => left - right);
}

function commentOf(row: Row, pullRequest: number): ReviewComment {
  const user = rowOf(row["user"], "gh");
  return {
    pullRequest,
    path: stringOf(row["path"], "gh"),
    line: lineOf(row),
    author: stringOf(user["login"], "gh"),
    bot: user["type"] === "Bot",
    text: stringOf(row["body"], "gh").slice(0, 2000),
    url: stringOf(row["html_url"], "gh"),
  };
}

async function reviewComments(
  system: FactsSystem,
  pulls: readonly number[],
): Promise<readonly ReviewComment[]> {
  const found: ReviewComment[] = [];
  for (const pullRequest of pulls) {
    const rows = pagedRows(
      await github(system, [
        "api",
        "--paginate",
        "--slurp",
        `repos/{owner}/{repo}/pulls/${String(pullRequest)}/comments?per_page=100`,
      ]),
    );
    found.push(
      ...rows
        .filter((row) => (row["in_reply_to_id"] ?? null) === null)
        .map((row) => commentOf(row, pullRequest)),
    );
  }
  return found.slice(0, commentLimit);
}

function severityOf(value: unknown): Severity {
  const level = isList(value) ? value[0] : value;
  const named = typeof level === "number" ? severities[level] : level;
  if (named === "off" || named === "warn" || named === "error") return named;
  throw unexpected("eslint");
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function printedRules(
  system: FactsSystem,
  path: string,
): Promise<Row | null> {
  const printed = await system.run({
    command: "node_modules/.bin/eslint",
    args: ["--print-config", path],
    github: false,
  });
  const value = printed.trim().startsWith("{")
    ? rowOf(parsedJson(printed, "eslint"), "eslint")
    : null;
  return value === null ? null : rowOf(value["rules"] ?? {}, "eslint");
}

async function lintRules(
  system: FactsSystem,
  comments: readonly ReviewComment[],
): Promise<Readonly<Record<string, Severity>>> {
  const paths = Array.from(
    new Set(
      comments
        .map((comment) => comment.path)
        .filter((path) => /\.[cm]?[jt]sx?$/.test(path)),
    ),
  ).slice(0, lintFileLimit);
  const rules = new Map<string, Severity>();
  for (const path of paths) {
    const printed = await printedRules(system, path).catch((error: unknown) => {
      if (missing(error)) return undefined;
      throw error;
    });
    if (printed === undefined) break;
    for (const [name, value] of Object.entries(printed ?? {})) {
      const level = severityOf(value);
      const known = rules.get(name) ?? "off";
      if (severities.indexOf(level) >= severities.indexOf(known))
        rules.set(name, level);
    }
  }
  return Object.fromEntries(
    Array.from(rules.entries()).sort(([left], [right]) =>
      left < right ? -1 : 1,
    ),
  );
}

async function openTickets(system: FactsSystem) {
  const rows = pagedRows(
    await github(system, ["api", "--paginate", "--slurp", checkIssues]),
  );
  return rows
    .filter((row) => row["pull_request"] === undefined)
    .map((row) => ({
      number: numberOf(row["number"]),
      title: stringOf(row["title"], "gh"),
      url: stringOf(row["html_url"], "gh"),
      check:
        /^Check: ([a-z][a-z0-9-]{0,63})$/m.exec(
          typeof row["body"] === "string" ? row["body"] : "",
        )?.[1] ?? null,
    }));
}

function decisionsOf(text: string) {
  return text
    .split("\n")
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => line.trim() !== "")
    .map(({ line, number }) => {
      const source = `The decisions file line ${String(number)}`;
      const row = rowOf(parsedJson(line, source), source);
      const links = row["links"];
      if (!isList(links)) throw unexpected(source);
      return {
        name: stringOf(row["name"], source),
        shape: stringOf(row["shape"], source),
        decision: stringOf(row["decision"], source),
        links: links.map((link) => stringOf(link, source)),
      };
    });
}

function qualityNames(names: readonly string[]): readonly string[] {
  return names
    .filter((name) => /^[\w.-]+\.[cm]?[jt]s$/.test(name))
    .filter((name) => !/\.d\.[cm]?ts$|\.test\./.test(name))
    .map((name) => name.replace(/\.[cm]?[jt]s$/, ""))
    .sort();
}

async function facts(system: FactsSystem) {
  const comments = await reviewComments(system, await mergedPulls(system));
  return {
    since: system.since,
    comments,
    lintRules: await lintRules(system, comments),
    qualityChecks: qualityNames(await system.qualityChecks()),
    openTickets: await openTickets(system),
    decisions: decisionsOf(await system.decisions()),
  };
}

export async function factsOutput(system: FactsSystem): Promise<ScriptOutput> {
  if (
    system.commandArguments.length !== 2 ||
    system.commandArguments.some((path) => !path.startsWith("/"))
  )
    return { stdout: "", stderr: `${usage}\n`, exitCode: 1 };
  try {
    return {
      stdout: `${JSON.stringify(await facts(system))}\n`,
      stderr: "",
      exitCode: 0,
    };
  } catch (error) {
    return {
      stdout: "",
      stderr: `${error instanceof Error ? error.message : String(error)}\n`,
      exitCode: 1,
    };
  }
}
