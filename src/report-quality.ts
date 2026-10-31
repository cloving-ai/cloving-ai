import type { Fields } from "./protocol.ts";
import { reportReviewScores } from "./report-effects.ts";
import {
  reportMetric,
  type ReportDatum,
  type ReportWindow,
} from "./report-statistics.ts";

export interface QualityJob {
  readonly id: number;
  readonly runId: number;
  readonly commit: string;
  readonly name: string;
  readonly attempt: number;
  readonly at: number;
  readonly conclusion: string | null;
}

function later(left: QualityJob, right: QualityJob): boolean {
  if (left.runId === right.runId) return left.attempt > right.attempt;
  return left.at > right.at;
}

export function reportFailureData(input: {
  readonly jobs: readonly QualityJob[];
  readonly names: Readonly<Record<number, readonly string[]>>;
}) {
  const groups = new Map<string, QualityJob[]>();
  for (const job of input.jobs) {
    const key = JSON.stringify([job.commit, job.name]);
    const group = groups.get(key) ?? [];
    group.push(job);
    groups.set(key, group);
  }
  const flaky: ReportDatum[] = [];
  const real: ReportDatum[] = [];
  for (const jobs of groups.values()) {
    const failed = jobs.filter((job) => job.conclusion === "failure");
    const passed = jobs.filter((job) => job.conclusion === "success");
    const flakyJobs = failed.filter((job) =>
      passed.some((success) => later(success, job)),
    );
    const realJobs = failed.filter(
      (job) => !passed.some((success) => later(success, job)),
    );
    const successes = passed.filter((job) =>
      flakyJobs.some((failure) => later(job, failure)),
    );
    flaky.push(
      ...failureDatum({
        failed: flakyJobs,
        passed: successes,
        names: input.names,
      }),
    );
    real.push(
      ...failureDatum({ failed: realJobs, passed: [], names: input.names }),
    );
  }
  return { flaky, real };
}

export interface ReportQualityData {
  readonly effects?: readonly Fields[] | null;
  readonly daemonObservedSince?: number | null;
  readonly reopened?: readonly ReportDatum[] | null;
  readonly reverts?: readonly ReportDatum[] | null;
  readonly jobLogs?: Readonly<Record<string, unknown>> | null;
  readonly mainFirstPass?: readonly ReportDatum[] | null;
  readonly failures?: {
    readonly flaky: readonly ReportDatum[];
    readonly real: readonly ReportDatum[];
  } | null;
}

export function reportQualityMetrics(
  input: ReportQualityData,
  window: ReportWindow,
) {
  const reviewScore = reviewMetrics(input, window);
  return {
    reviewScore,
    reopenedTickets: reportMetric({
      data: input.reopened ?? null,
      window,
      aggregation: "count",
    }),
    revertedPullRequests: reportMetric({
      data: input.reverts ?? null,
      window,
      aggregation: "count",
    }),
    jobLogs: input.jobLogs ?? { status: "unavailable" },
    mainFirstPassShare: reportMetric({
      data: input.mainFirstPass ?? null,
      window,
      aggregation: "mean",
    }),
    flakyFailures: reportMetric({
      data: input.failures?.flaky ?? null,
      window,
      aggregation: "distinct",
    }),
    realFailures: reportMetric({
      data: input.failures?.real ?? null,
      window,
      aggregation: "distinct",
    }),
  };
}

function reviewMetrics(input: ReportQualityData, window: ReportWindow) {
  const rounds = reportReviewScores(input.effects ?? null);
  const reviewScore = Object.fromEntries(
    Object.entries(rounds ?? { round1: null }).map(([key, data]) => [
      key,
      reportMetric({
        data,
        window: { ...window, observedSince: input.daemonObservedSince ?? null },
        aggregation: "median",
      }),
    ]),
  );
  return reviewScore;
}

function failureDatum(input: {
  readonly failed: readonly QualityJob[];
  readonly passed: readonly QualityJob[];
  readonly names: Readonly<Record<number, readonly string[]>>;
}): ReportDatum[] {
  return input.failed.map((failed) => {
    const passed = input.passed.filter((job) => later(job, failed));
    const jobs = [failed, ...passed];
    return {
      at: failed.at,
      value: 1,
      key: JSON.stringify([failed.commit, failed.name]),
      evidence: {
        commit: failed.commit,
        jobName: failed.name,
        testNames: input.names[failed.id] ?? ["unknown"],
        jobIds: jobs.map((job) => job.id),
        runIds: [...new Set(jobs.map((job) => job.runId))],
      },
    };
  });
}
