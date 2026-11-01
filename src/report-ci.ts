import {
  reportMetric,
  type ReportDatum,
  type ReportWindow,
} from "./report-statistics.ts";

export const runnerKinds = [
  "localMacos",
  "localLinux",
  "hostedMacos",
  "hostedLinux",
] as const;
export type RunnerKind = (typeof runnerKinds)[number];
export type RunnerData = Readonly<Record<RunnerKind, readonly ReportDatum[]>>;
export interface ReportCiData {
  readonly jobMinutes: RunnerData | null;
  readonly jobLimitShare: RunnerData | null;
  readonly runnerWaitMinutes: RunnerData | null;
  readonly timeouts: readonly ReportDatum[] | null;
  readonly reruns: readonly ReportDatum[] | null;
}

export function reportCiMetrics(
  input: ReportCiData | undefined,
  window: ReportWindow,
) {
  const runners = (data: RunnerData | null | undefined) =>
    Object.fromEntries(
      runnerKinds.map((kind) => [
        kind,
        reportMetric({
          data: data?.[kind] ?? null,
          window,
          aggregation: "median",
        }),
      ]),
    );
  return {
    jobMinutes: runners(input?.jobMinutes),
    jobLimitShare: runners(input?.jobLimitShare),
    runnerWaitMinutes: runners(input?.runnerWaitMinutes),
    timeouts: reportMetric({
      data: input?.timeouts ?? null,
      window,
      aggregation: "count",
    }),
    reruns: reportMetric({
      data: input?.reruns ?? null,
      window,
      aggregation: "count",
    }),
  };
}
