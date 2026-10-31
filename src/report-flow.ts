import { reportReadyData } from "./report-ready.ts";
import type {
  ReportCompletion,
  ReportFlow,
  ReportFlowRun,
  ReportReadyTicket,
} from "./report-flow-types.ts";
import {
  reportMetric,
  type ReportDatum,
  type ReportWindow,
} from "./report-statistics.ts";

function overlaps(run: ReportFlowRun, window: ReportWindow): boolean {
  return run.start < window.end && (run.end ?? window.end) > window.start;
}

function busyShare(input: ReportFlow, window: ReportWindow) {
  const queue = input.queue;
  const runs = input.runs;
  if (queue === null || runs === null) return null;
  const active = runs.filter((run) => overlaps(run, window));
  if (active.some((run) => run.workflowId === null)) return null;
  const own = active.filter((run) => run.workflowId === queue.workflowId);
  const milliseconds = own.reduce(
    (sum, run) =>
      sum +
      Math.max(
        0,
        Math.min(run.end ?? window.end, window.end) -
          Math.max(run.start, window.start),
      ),
    0,
  );
  return {
    at: window.start,
    value: milliseconds / (queue.lanes * (window.end - window.start)),
    evidence: {
      workflowId: queue.workflowId,
      lanes: queue.lanes,
      runIds: own.map((run) => run.runId),
    },
  };
}

function peakRuns(runs: readonly ReportFlowRun[], window: ReportWindow) {
  const points = [...new Set([window.start, ...runs.map((run) => run.start)])]
    .filter((at) => at >= window.start && at < window.end)
    .toSorted((a, b) => a - b);
  let peak: string[] = [];
  for (const at of points) {
    const active = runs.filter(
      (run) => run.start <= at && (run.end ?? window.end) > at,
    );
    if (active.length > peak.length) peak = active.map((run) => run.runId);
  }
  return { at: window.start, value: peak.length, evidence: { runIds: peak } };
}

function streaks(
  completions: readonly ReportCompletion[],
  window: ReportWindow,
) {
  const ended = completions
    .filter((event) => event.at < window.end)
    .toSorted((a, b) => a.at - b.at || a.sequence - b.sequence);
  let current: string[] = [];
  let inWindow: string[] = [];
  let longest: string[] = [];
  for (const event of ended) {
    current = event.outcome === "completed" ? [] : [...current, event.runId];
    if (event.at < window.start) continue;
    inWindow = event.outcome === "completed" ? [] : [...inWindow, event.runId];
    if (inWindow.length > longest.length) longest = inWindow;
  }
  return { current, longest };
}

interface FlowInput {
  readonly flow: ReportFlow | undefined;
  readonly completions: readonly ReportCompletion[] | null;
  readonly ready: ReadyInput;
}

interface ReadyInput {
  readonly tickets: readonly ReportReadyTicket[] | null;
  readonly observedSince: number | null;
}

type FlowSeries = Record<string, readonly ReportDatum[] | null>;

function windowData(input: FlowInput, window: ReportWindow): FlowSeries {
  const busy = input.flow === undefined ? null : busyShare(input.flow, window);
  const peak =
    input.flow?.runs == null ? null : peakRuns(input.flow.runs, window);
  const streak =
    input.completions === null ? null : streaks(input.completions, window);
  const waits = reportReadyData(
    { tickets: input.ready.tickets, flow: input.flow },
    window,
  );
  return {
    "flow.busyLaneShare": busy === null ? null : [busy],
    "flow.peakActiveRuns": peak === null ? null : [peak],
    "flow.unsuccessfulStreak.current":
      streak === null
        ? null
        : [
            {
              at: window.start,
              value: streak.current.length,
              evidence: { runIds: streak.current },
            },
          ],
    "flow.unsuccessfulStreak.longest":
      streak === null
        ? null
        : [
            {
              at: window.start,
              value: streak.longest.length,
              evidence: { runIds: streak.longest },
            },
          ],
    "flow.idleLaneHoursWithReadyTicket": waits.idle,
    "flow.readyWaitHours.dependency": waits.dependency,
    "flow.readyWaitHours.noLane": waits.noLane,
  };
}

function sampleWindows(window: ReportWindow): ReportWindow[] {
  return [
    window,
    ...Array.from({ length: 7 }, (_, index) => ({
      ...window,
      start: window.start - (index + 1) * 86_400_000,
      end: window.start - index * 86_400_000,
    })),
  ];
}

function metricWindow(
  name: string,
  input: { readonly window: ReportWindow; readonly ready: ReadyInput },
): ReportWindow {
  const { window, ready } = input;
  if (!name.includes("ReadyTicket") && !name.includes("readyWaitHours"))
    return window;
  const origin = ready.observedSince;
  if (name.endsWith("dependency")) return { ...window, observedSince: origin };
  const observedSince =
    origin === null || window.observedSince === null
      ? null
      : Math.max(origin, window.observedSince);
  return { ...window, observedSince };
}

function sampledMetrics(input: FlowInput, window: ReportWindow) {
  const windows = sampleWindows(window);
  const samples = windows.map((sample) => windowData(input, sample));
  const metrics: Record<string, ReturnType<typeof reportMetric>> = {};
  for (const name of Object.keys(samples[0] ?? {})) {
    const current = samples[0]?.[name];
    const data =
      current == null
        ? null
        : samples.flatMap(
            (sample, index) =>
              sample[name] ?? [
                {
                  at: windows[index]?.start ?? window.start,
                  value: null,
                  evidence: {},
                },
              ],
          );
    metrics[name] = reportMetric({
      data,
      window: metricWindow(name, { window, ready: input.ready }),
      aggregation: name.includes("Hours") ? "count" : "median",
    });
  }
  return metrics;
}

function workflowIds(input: ReportFlow | undefined): Set<string> {
  const flow = input ?? { runs: [], queue: null, skips: [], workflows: [] };
  const queue = flow.queue === null ? [] : [flow.queue.workflowId];
  return new Set([
    ...(flow.workflows ?? []),
    ...(flow.skips ?? []).map((skip) => skip.workflowId),
    ...(flow.runs ?? []).flatMap((run) =>
      run.workflowId === null ? [] : [run.workflowId],
    ),
    ...queue,
  ]);
}

function skipMetrics(input: ReportFlow | undefined, window: ReportWindow) {
  const workflows = workflowIds(input);
  const metrics: Record<string, ReturnType<typeof reportMetric>> = {
    "flow.scheduleSkips": reportMetric({
      data:
        input?.skips == null
          ? null
          : input.skips.map((skip) => ({
              at: skip.at,
              value: 1,
              evidence: {
                workflowId: skip.workflowId,
                sequence: skip.sequence,
              },
            })),
      window,
      aggregation: "count",
    }),
  };
  for (const workflowId of workflows)
    metrics[`flow.scheduleSkips.${workflowId}`] = reportMetric({
      data:
        input?.skips == null
          ? null
          : input.skips
              .filter((skip) => skip.workflowId === workflowId)
              .map((skip) => ({
                at: skip.at,
                value: 1,
                evidence: { workflowId, sequence: skip.sequence },
              })),
      window,
      aggregation: "count",
    });
  return metrics;
}

export function reportFlowMetrics(input: FlowInput, window: ReportWindow) {
  return {
    ...sampledMetrics(input, window),
    ...skipMetrics(input.flow, window),
  };
}
