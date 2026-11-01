import { record, type Fields } from "../protocol.ts";
import { type ReportCiData, type RunnerKind } from "../report-ci.ts";
import type { ReportDatum } from "../report-statistics.ts";
import { ciJobs, type ReportJob } from "./report-ci-jobs.ts";
import {
  reportSource,
  timestamp,
  type Reader,
} from "./report-github-reader.ts";

type JobGroups = Record<RunnerKind, ReportDatum[]>;
interface CiUsageRead {
  readonly data: ReportCiData;
  readonly sources: Readonly<
    Record<"ciUsageJobs" | "ciUsageWorkflows", ReturnType<typeof reportSource>>
  >;
}
function groups(): JobGroups {
  return { localMacos: [], localLinux: [], hostedMacos: [], hostedLinux: [] };
}

function workflowEndpoint(run: Fields): string {
  const path = run["path"];
  const commit = run["head_sha"];
  if (
    typeof path !== "string" ||
    !path.startsWith(".github/workflows/") ||
    typeof commit !== "string" ||
    !/^[a-f0-9]{40,64}$/i.test(commit)
  )
    throw new Error("response");
  const file = path.replace(/@.*$/, "");
  return `contents/${file}?ref=${commit}`;
}

async function workflowJobs(reader: Reader, run: Fields): Promise<Fields> {
  const response = record(await reader.read(workflowEndpoint(run)));
  if (
    response?.["encoding"] !== "base64" ||
    typeof response["content"] !== "string"
  )
    throw new Error("response");
  const text = Buffer.from(response["content"], "base64").toString("utf8");
  try {
    return record(record(JSON.parse(text))?.["jobs"]) ?? {};
  } catch {
    return {};
  }
}

function definitionOf(jobs: Fields, name: string): Fields {
  const key = name.split(" (")[0] ?? name;
  return (
    record(jobs[key]) ??
    Object.values(jobs)
      .map(record)
      .find((job) => job?.["name"] === name) ??
    {}
  );
}

function runnerSystem(value: unknown): "Macos" | "Linux" | null {
  if (typeof value === "string") return runnerSystem([value]);
  if (
    !Array.isArray(value) ||
    !value.every((item: unknown) => typeof item === "string")
  )
    return null;
  const description = value.join(" ").toLowerCase();
  const macos = /\bmacos\b|\bosx\b/.test(description);
  const linux = /\blinux\b|\bubuntu\b/.test(description);
  if (macos === linux) return null;
  return macos ? "Macos" : "Linux";
}

function runnerKind(row: Fields, definition: Fields): RunnerKind {
  const labels = row["labels"];
  if (
    !Array.isArray(labels) ||
    !labels.every((label: unknown) => typeof label === "string")
  )
    throw new Error("response");
  const local = labels.includes("self-hosted");
  const system =
    runnerSystem(labels) ??
    (local ? null : runnerSystem(definition["runs-on"]));
  if (system === null) throw new Error("runner-kind");
  return `${local ? "local" : "hosted"}${system}`;
}

function jobValues(job: ReportJob, definition: Fields) {
  const row = job.details;
  const start = timestamp(row["started_at"]);
  const end =
    row["completed_at"] === null ? null : timestamp(row["completed_at"]);
  const created = timestamp(row["created_at"]);
  if (created > start || (end !== null && start > end))
    throw new Error("response");
  const minutes = end === null ? null : (end - start) / 60_000;
  const timeout = definition["timeout-minutes"];
  const limit =
    typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0
      ? timeout
      : null;
  return {
    kind: runnerKind(row, definition),
    minutes,
    wait: (start - created) / 60_000,
    limit,
  };
}

function appendJob(
  target: {
    readonly jobMinutes: JobGroups;
    readonly jobLimitShare: JobGroups;
    readonly runnerWaitMinutes: JobGroups;
    readonly timeouts: ReportDatum[];
  },
  input: {
    readonly job: ReportJob;
    readonly definitions: ReadonlyMap<number, Fields | null>;
  },
) {
  const { job, definitions } = input;
  const definition = definitionOf(definitions.get(job.runId) ?? {}, job.name);
  const values = jobValues(job, definition);
  const evidence = {
    jobId: job.id,
    runId: job.runId,
    attempt: job.attempt,
    jobName: job.name,
    minutes: values.minutes,
    limitMinutes: values.limit,
  };
  const datum = { at: job.at, evidence };
  if (values.minutes !== null)
    target.jobMinutes[values.kind].push({ ...datum, value: values.minutes });
  target.runnerWaitMinutes[values.kind].push({ ...datum, value: values.wait });
  if (values.limit !== null && values.minutes !== null)
    target.jobLimitShare[values.kind].push({
      ...datum,
      value: values.minutes / values.limit,
    });
  if (
    job.conclusion === "timed_out" ||
    (values.limit !== null &&
      values.minutes !== null &&
      values.minutes >= values.limit)
  )
    target.timeouts.push({ ...datum, value: 1 });
}

function jobData(
  jobs: readonly ReportJob[],
  definitions: ReadonlyMap<number, Fields | null>,
) {
  const jobMinutes = groups();
  const jobLimitShare = groups();
  const runnerWaitMinutes = groups();
  const timeouts: ReportDatum[] = [];
  for (const job of jobs) {
    if (job.details["started_at"] === null || job.conclusion === "skipped")
      continue;
    appendJob(
      { jobMinutes, jobLimitShare, runnerWaitMinutes, timeouts },
      { job, definitions },
    );
  }
  const limitsKnown = [...definitions.values()].every(
    (value) => value !== null,
  );
  return {
    jobMinutes,
    runnerWaitMinutes,
    jobLimitShare: limitsKnown ? jobLimitShare : null,
    timeouts: limitsKnown ? timeouts : null,
  };
}

async function workflowDefinitions(reader: Reader, runs: readonly Fields[]) {
  const results = await Promise.allSettled(
    runs.map((run) => workflowJobs(reader, run)),
  );
  return {
    definitions: new Map(
      runs.map((run, index) => {
        const result = results[index];
        return [
          Number(run["id"]),
          result?.status === "fulfilled" ? result.value : null,
        ] as const;
      }),
    ),
    source: reportSource(
      results.find((result) => result.status === "rejected") ?? {
        status: "fulfilled",
        value: null,
      },
    ),
  };
}

export async function readCiUsage(
  reader: Reader,
  runs: readonly Fields[],
): Promise<CiUsageRead> {
  const reruns = runs
    .filter((run) => Number(run["run_attempt"]) > 1)
    .map((run) => ({
      at: timestamp(run["run_started_at"] ?? run["updated_at"]),
      value: 1,
      evidence: { runId: run["id"], attempt: run["run_attempt"] },
    }));
  const empty = {
    jobMinutes: null,
    jobLimitShare: null,
    runnerWaitMinutes: null,
    timeouts: null,
    reruns,
  };
  const [jobs] = await Promise.allSettled([ciJobs(reader, runs)]);
  const workflows = await workflowDefinitions(reader, runs);
  const sources = {
    ciUsageJobs: reportSource(jobs),
    ciUsageWorkflows: workflows.source,
  };
  if (jobs.status === "rejected") return { data: empty, sources };
  try {
    return {
      data: { ...jobData(jobs.value, workflows.definitions), reruns },
      sources,
    };
  } catch (reason) {
    return {
      data: empty,
      sources: {
        ...sources,
        ciUsageJobs: reportSource({ status: "rejected", reason }),
      },
    };
  }
}
