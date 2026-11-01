import { readClosureHistory } from "./report-closures.ts";
import { readCiJobs } from "./report-ci-jobs.ts";
import { reportFailureData } from "../report-quality.ts";
import { mainRuns, firstPassData } from "./report-ci.ts";
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
  readonly reopened: readonly ReportDatum[] | null;
  readonly reverts: readonly ReportDatum[] | null;
  readonly jobLogs: Awaited<ReturnType<typeof readCiJobs>>["jobLogs"] | null;
  readonly failures: ReturnType<typeof reportFailureData> | null;
  readonly mainFirstPass: readonly ReportDatum[] | null;
  readonly observedSince: number | null;
  readonly issues: readonly ReportDatum[] | null;
  readonly pulls: readonly ReportDatum[] | null;
  readonly leadTimes: readonly ReportDatum[] | null;
  readonly ready: readonly ReportReadyTicket[] | null;
  readonly sources: Readonly<
    Record<
      "issues" | "pulls" | "history" | "timelines" | "ready" | "ci" | "jobs",
      { readonly status: string; readonly reason?: string }
    >
  >;
}

function unavailableGithub(): ReportGithub {
  const unavailable = {
    status: "unavailable",
    reason: "configuration-or-identity",
  };
  return {
    reopened: null,
    reverts: null,
    jobLogs: null,
    failures: null,
    mainFirstPass: null,
    observedSince: null,
    issues: null,
    pulls: null,
    leadTimes: null,
    ready: null,
    sources: {
      jobs: unavailable,
      ci: unavailable,
      ready: unavailable,
      issues: unavailable,
      pulls: unavailable,
      history: unavailable,
      timelines: unavailable,
    },
  };
}

export async function readReportGithub(
  input: GithubReportInput,
): Promise<ReportGithub> {
  const reader = await repositoryReader(input).catch(() => null);
  if (reader === null) return unavailableGithub();
  const runsRead = mainRuns(reader, {
    since: input.since,
    activity: "created",
  });
  const issueRead = readClosureHistory(reader, input.since);
  const [issues, pulls, history, timelines, ready, ci, jobs] =
    await Promise.allSettled([
      issueRead,
      pullsOf(reader, input.since),
      repositoryCreatedAt(reader),
      issueRead.then((values) =>
        leadTimesOf(reader, { issues: values.completed, since: input.since }),
      ),
      readyTicketsOf(reader),
      runsRead.then((runs) => firstPassData(reader, runs)),
      mainRuns(reader, { since: input.since, activity: "updated" }).then(
        (runs) => readCiJobs(reader, runs),
      ),
    ]);
  return {
    reopened: issues.status === "fulfilled" ? issues.value.reopened : null,
    reverts: pulls.status === "fulfilled" ? pulls.value.reverts : null,
    ...qualitySources({ jobs, ci }),
    observedSince: history.status === "fulfilled" ? history.value : null,
    issues: issues.status === "fulfilled" ? issues.value.completed : null,
    pulls: pulls.status === "fulfilled" ? pulls.value.pulls : null,
    ready: ready.status === "fulfilled" ? ready.value : null,
    leadTimes: timelines.status === "fulfilled" ? timelines.value : null,
    sources: {
      jobs: source(jobs),
      ci: source(ci),
      ready: source(ready),
      issues: source(issues),
      pulls: source(pulls),
      history: source(history),
      timelines: source(timelines),
    },
  };
}

import { record, type Fields } from "../protocol.ts";

async function pullsOf(reader: Reader, since: string) {
  const reverts: (ReportDatum | null)[] = [];
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
      const datum = {
        at: timestamp(row["merged_at"]),
        value: 1,
        evidence: { pullRequest: number },
      };
      result.push(datum);
      reverts.push(...revertOf(row, datum));
    }
    if (
      values.length < 100 ||
      values.some(
        (row) => Date.parse(String(row["updated_at"])) < Date.parse(since),
      )
    )
      return {
        pulls: result,
        reverts: reverts.includes(null)
          ? null
          : reverts.filter((item) => item !== null),
      };
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

function qualitySources(input: {
  readonly jobs: PromiseSettledResult<Awaited<ReturnType<typeof readCiJobs>>>;
  readonly ci: PromiseSettledResult<readonly ReportDatum[]>;
}) {
  const { jobs, ci } = input;
  return {
    jobLogs: jobs.status === "fulfilled" ? jobs.value.jobLogs : null,
    failures:
      jobs.status === "fulfilled" ? reportFailureData(jobs.value) : null,
    mainFirstPass: ci.status === "fulfilled" ? ci.value : null,
  };
}

function revertOf(row: Fields, datum: ReportDatum): (ReportDatum | null)[] {
  const title = row["title"];
  if (typeof title !== "string") return [null];
  return title.startsWith('Revert "') ? [datum] : [];
}
