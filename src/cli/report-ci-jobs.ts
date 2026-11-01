import { record, type Fields } from "../protocol.ts";
import { rows, timestamp, type Reader } from "./report-github-reader.ts";
import { positiveInteger } from "./report-ci.ts";

export interface ReportJob {
  readonly id: number;
  readonly runId: number;
  readonly commit: string;
  readonly name: string;
  readonly attempt: number;
  readonly at: number;
  readonly conclusion: string | null;
}

function parsedJob(row: Fields, run: Fields): ReportJob {
  const name = row["name"];
  const commit = run["head_sha"];
  const conclusion = jobConclusion(row["conclusion"]);
  if (
    typeof name !== "string" ||
    name === "" ||
    typeof commit !== "string" ||
    !/^[a-f0-9]{40,64}$/i.test(commit) ||
    row["head_sha"] !== commit ||
    row["run_id"] !== run["id"]
  )
    throw new Error("response");
  return {
    id: positiveInteger(row["id"]),
    name,
    commit,
    conclusion,
    runId: positiveInteger(run["id"]),
    attempt: positiveInteger(run["run_attempt"]),
    at: timestamp(
      row["completed_at"] ?? row["started_at"] ?? run["created_at"],
    ),
  };
}

async function attemptJobs(reader: Reader, run: Fields): Promise<ReportJob[]> {
  const result: ReportJob[] = [];
  const seen = new Set<number>();
  for (let page = 1; ; page += 1) {
    const response = record(
      await reader.read(
        `actions/runs/${String(run["id"])}/attempts/${String(run["run_attempt"])}/jobs?per_page=100&page=${String(page)}`,
      ),
    );
    const values = rows(response?.["jobs"]);
    for (const row of values) {
      const job = parsedJob(row, run);
      if (seen.has(job.id)) throw new Error("response");
      seen.add(job.id);
      result.push(job);
    }
    if (values.length < 100) return result;
  }
}

export async function readCiJobs(reader: Reader, runs: readonly Fields[]) {
  const jobs: ReportJob[] = [];
  for (const run of runs) {
    const attempts = positiveInteger(run["run_attempt"]);
    for (let attempt = 1; attempt <= attempts; attempt += 1)
      jobs.push(
        ...(await attemptJobs(reader, { ...run, run_attempt: attempt })),
      );
  }
  const names: Record<number, readonly string[]> = {};
  const failed = [
    ...new Map(
      jobs
        .filter((item) => item.conclusion === "failure")
        .map((job) => [job.id, job]),
    ).values(),
  ];
  for (const job of failed.slice(0, 50)) {
    const log = await reader
      .readLog(`actions/jobs/${String(job.id)}/logs`)
      .catch(() => "");
    names[job.id] = failedTestNames(log);
  }
  return {
    jobs,
    names,
    jobLogs: {
      read: Math.min(failed.length, 50),
      notRead: Math.max(0, failed.length - 50),
      limit: 50,
      maximumBytes: 2 * 1024 * 1024,
    },
  };
}

function failedTestNames(log: string): readonly string[] {
  const lines = log
    .split(/\r?\n/)
    .map((line) => line.replace(/^\d{4}-\d{2}-\d{2}T\S+ /, ""));
  const names = new Set<string>();
  let reading = false;
  for (const line of lines) {
    if (line === "Failed tests:") {
      reading = true;
      continue;
    }
    if (!reading || /^\s/.test(line)) continue;
    if (
      line === "" ||
      /^(?:\d+ failures not shown\.|Error: test-report-failure\. Full test report:)/.test(
        line,
      )
    ) {
      reading = false;
      continue;
    }
    names.add(line);
  }
  return names.size === 0 ? ["unknown"] : [...names];
}

function jobConclusion(value: unknown): string | null {
  if (value === null || typeof value === "string") return value;
  throw new Error("response");
}
