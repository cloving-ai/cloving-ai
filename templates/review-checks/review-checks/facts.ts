import { runCommand } from "cloving/workflows/steps/run-command";
import { count, list, record, resultJson, text, type Fields } from "./input.ts";

export type Answer = "accept" | "reject" | "defer";
export type Severity = "off" | "warn" | "error";

export interface ReviewComment {
  readonly pullRequest: number;
  readonly path: string;
  readonly line: number | null;
  readonly author: string;
  readonly bot: boolean;
  readonly text: string;
  readonly url: string;
}

export interface OpenTicket {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly check: string | null;
}

export interface EarlierDecision {
  readonly name: string;
  readonly shape: string;
  readonly decision: Answer;
  readonly links: readonly string[];
}

export interface ReviewFacts {
  readonly since: string;
  readonly comments: readonly ReviewComment[];
  readonly lintRules: Readonly<Record<string, Severity>>;
  readonly qualityChecks: readonly string[];
  readonly openTickets: readonly OpenTicket[];
  readonly decisions: readonly EarlierDecision[];
}

const bad = "invalid-review-comments";
const checkName = /^[a-z][a-z0-9-]{0,63}$/;
const address = /^https:\/\/\S+$/;

function positive(value: unknown): number {
  const number = count(value, bad);
  if (number < 1) throw new Error(bad);
  return number;
}

function commentOf(value: unknown): ReviewComment {
  const item = record(value, bad);
  const bot = item["bot"];
  if (typeof bot !== "boolean") throw new Error(bad);
  return {
    pullRequest: positive(item["pullRequest"]),
    path: text(item["path"], { reason: bad, pattern: /^\S/, maximum: 500 }),
    line: item["line"] === null ? null : positive(item["line"]),
    author: text(item["author"], {
      reason: bad,
      pattern: /^\S+$/,
      maximum: 100,
    }),
    bot: bot,
    text: text(item["text"], { reason: bad, pattern: /^/, maximum: 2000 }),
    url: text(item["url"], { reason: bad, pattern: address, maximum: 300 }),
  };
}

function severityOf(value: unknown): Severity {
  if (value === "off" || value === "warn" || value === "error") return value;
  throw new Error(bad);
}

function answerOf(value: unknown): Answer {
  if (value === "accept" || value === "reject" || value === "defer")
    return value;
  throw new Error(bad);
}

function ticketOf(value: unknown): OpenTicket {
  const item = record(value, bad);
  return {
    number: positive(item["number"]),
    title: text(item["title"], { reason: bad, pattern: /^/, maximum: 500 }),
    url: text(item["url"], { reason: bad, pattern: address, maximum: 300 }),
    check:
      item["check"] === null
        ? null
        : text(item["check"], { reason: bad, pattern: checkName, maximum: 64 }),
  };
}

function decisionOf(value: unknown): EarlierDecision {
  const item = record(value, bad);
  return {
    name: text(item["name"], { reason: bad, pattern: checkName, maximum: 64 }),
    shape: text(item["shape"], { reason: bad, pattern: /^/, maximum: 600 }),
    decision: answerOf(item["decision"]),
    links: list(item["links"], { reason: bad, maximum: 20 }).map((link) =>
      text(link, { reason: bad, pattern: address, maximum: 300 }),
    ),
  };
}

export function factsOf(value: unknown): ReviewFacts {
  const facts: Fields = record(value, bad);
  return {
    since: text(facts["since"], {
      reason: bad,
      pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
      maximum: 20,
    }),
    comments: list(facts["comments"], { reason: bad, maximum: 200 }).map(
      (item) => commentOf(item),
    ),
    lintRules: Object.fromEntries(
      Object.entries(record(facts["lintRules"], bad)).map(([name, level]) => [
        text(name, { reason: bad, pattern: /^\S+$/, maximum: 200 }),
        severityOf(level),
      ]),
    ),
    qualityChecks: list(facts["qualityChecks"], {
      reason: bad,
      maximum: 500,
    }).map((name) =>
      text(name, { reason: bad, pattern: /^[\w.-]+$/, maximum: 100 }),
    ),
    openTickets: list(facts["openTickets"], { reason: bad, maximum: 500 }).map(
      (item) => ticketOf(item),
    ),
    decisions: list(facts["decisions"], { reason: bad, maximum: 2000 }).map(
      (item) => decisionOf(item),
    ),
  };
}

export async function reviewFacts(): Promise<ReviewFacts> {
  const empty: Readonly<Record<string, never>> = {};
  return factsOf(
    resultJson(
      await runCommand({
        scope: { phase: "checks", operation: "review-comments", round: 1 },
        name: "review-comments",
        input: empty,
      }),
      bad,
    ),
  );
}
