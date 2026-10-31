import type { ReportDatum } from "../report-statistics.ts";
import {
  repositoryReader,
  issueTimeline,
  rows,
  identity,
  timestamp,
  type Reader,
  type GithubReportInput,
} from "./report-github-reader.ts";
import { readyTicketsOf } from "./report-ready.ts";
import type { ReportReadyTicket } from "../report-flow-types.ts";

export interface ReportGithub {
  readonly observedSince: number | null;
  readonly issues: readonly ReportDatum[] | null;
  readonly pulls: readonly ReportDatum[] | null;
  readonly leadTimes: readonly ReportDatum[] | null;
  readonly ready: readonly ReportReadyTicket[] | null;
  readonly sources: Readonly<
    Record<
      "issues" | "pulls" | "history" | "timelines" | "ready",
      { readonly status: string; readonly reason?: string }
    >
  >;
}

export async function readReportGithub(
  input: GithubReportInput,
): Promise<ReportGithub> {
  const reader = await repositoryReader(input).catch(() => null);
  if (reader === null)
    return {
      observedSince: null,
      issues: null,
      pulls: null,
      leadTimes: null,
      ready: null,
      sources: {
        ready: { status: "unavailable", reason: "configuration-or-identity" },
        issues: { status: "unavailable", reason: "configuration-or-identity" },
        pulls: { status: "unavailable", reason: "configuration-or-identity" },
        history: { status: "unavailable", reason: "configuration-or-identity" },
        timelines: {
          status: "unavailable",
          reason: "configuration-or-identity",
        },
      },
    };
  const issueRead = issuesOf(reader, input.since);
  const [issues, pulls, history, timelines, ready] = await Promise.allSettled([
    issueRead,
    pullsOf(reader, input.since),
    repositoryCreatedAt(reader),
    issueRead.then((values) =>
      leadTimesOf(reader, { issues: values, since: input.since }),
    ),
    readyTicketsOf(reader),
  ]);
  return {
    observedSince: history.status === "fulfilled" ? history.value : null,
    issues: issues.status === "fulfilled" ? issues.value : null,
    pulls: pulls.status === "fulfilled" ? pulls.value : null,
    ready: ready.status === "fulfilled" ? ready.value : null,
    leadTimes: timelines.status === "fulfilled" ? timelines.value : null,
    sources: {
      ready: source(ready),
      issues: source(issues),
      pulls: source(pulls),
      history: source(history),
      timelines: source(timelines),
    },
  };
}

import { record, type Fields } from "../protocol.ts";

async function issuesOf(
  reader: Reader,
  since: string,
): Promise<readonly ReportDatum[]> {
  const result: ReportDatum[] = [];
  const seen = new Set<number>();
  for (let page = 1; ; page += 1) {
    const values = rows(
      await reader.read(
        `issues?state=closed&since=${encodeURIComponent(since)}&per_page=100&page=${String(page)}`,
        [
          "--jq",
          'map({number, html_url, closed_at, state, state_reason} + (if has("pull_request") then {pull_request: {}} else {} end))',
        ],
      ),
    );
    for (const row of values) {
      if (Object.hasOwn(row, "pull_request")) continue;
      const number = identity(row, {
        repository: reader.repository,
        kind: "issues",
      });
      if (seen.has(number)) throw new Error("response");
      seen.add(number);
      if (!completedIssue(row)) continue;
      result.push({
        at: timestamp(row["closed_at"]),
        value: 1,
        evidence: { issue: number },
      });
    }
    if (values.length < 100) return result;
  }
}

async function pullsOf(
  reader: Reader,
  since: string,
): Promise<readonly ReportDatum[]> {
  const result: ReportDatum[] = [];
  const seen = new Set<number>();
  for (let page = 1; ; page += 1) {
    const values = rows(
      await reader.read(
        `pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${String(page)}`,
      ),
    );
    for (const row of values) {
      const number = identity(row, {
        repository: reader.repository,
        kind: "pull",
      });
      if (seen.has(number)) throw new Error("response");
      seen.add(number);
      timestamp(row["updated_at"]);
      if (row["merged_at"] === null) continue;
      result.push({
        at: timestamp(row["merged_at"]),
        value: 1,
        evidence: { pullRequest: number },
      });
    }
    if (
      values.length < 100 ||
      values.some(
        (row) => Date.parse(String(row["updated_at"])) < Date.parse(since),
      )
    )
      return result;
  }
}

function source(result: PromiseSettledResult<unknown>) {
  if (result.status === "fulfilled") return { status: "available" };
  const reason =
    result.reason instanceof Error &&
    result.reason.message === "github-network-failed"
      ? "github-network-failed"
      : "read-failed";
  return { status: "unavailable", reason };
}

async function repositoryCreatedAt(reader: Reader): Promise<number> {
  const repository = record(await reader.read(""));
  const name = repository?.["full_name"];
  if (
    typeof name !== "string" ||
    name.toLowerCase() !==
      `${reader.repository.owner}/${reader.repository.repository}`
  )
    throw new Error("identity");
  return timestamp(repository?.["created_at"]);
}

function completedIssue(row: Fields): boolean {
  if (
    row["state"] !== "closed" ||
    !["completed", "not_planned", "duplicate"].includes(
      String(row["state_reason"]),
    )
  )
    throw new Error("response");
  return row["state_reason"] === "completed";
}

async function lastReadyAt(
  reader: Reader,
  issue: ReportDatum,
): Promise<number | null> {
  let ready: number | null = null;
  for (const row of await issueTimeline(
    reader,
    Number(issue.evidence["issue"]),
  )) {
    if (!readyLabel(row)) continue;
    const at = timestamp(row["created_at"]);
    if (at <= issue.at && (ready === null || at > ready)) ready = at;
  }
  return ready;
}

async function leadTimesOf(
  reader: Reader,
  input: { readonly issues: readonly ReportDatum[]; readonly since: string },
): Promise<readonly ReportDatum[]> {
  const result: ReportDatum[] = [];
  for (const issue of input.issues.filter(
    (item) => item.at >= Date.parse(input.since),
  )) {
    const ready = await lastReadyAt(reader, issue);
    result.push({
      at: issue.at,
      value: ready === null ? null : (issue.at - ready) / 3_600_000,
      evidence: {
        ...issue.evidence,
        readyAt: ready === null ? null : new Date(ready).toISOString(),
        closedAt: new Date(issue.at).toISOString(),
      },
    });
  }
  return result;
}

function readyLabel(row: Fields): boolean {
  return (
    row["event"] === "labeled" &&
    record(row["label"])?.["name"] === "cloving: ready"
  );
}
