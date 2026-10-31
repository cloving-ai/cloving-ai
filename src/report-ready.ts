import type { ReportFlow, ReportReadyTicket } from "./report-flow-types.ts";
import type { ReportDatum, ReportWindow } from "./report-statistics.ts";

interface ReadyInput {
  readonly tickets: readonly ReportReadyTicket[] | null;
  readonly flow: ReportFlow | undefined;
}

interface WaitSummary {
  readonly dependency: Map<number, number>;
  readonly noLane: Map<number, number>;
  readonly idleIssues: Set<number>;
  readonly idleRuns: Set<string>;
  readonly fullRuns: Set<string>;
  idle: number;
}

function boundaries(input: ReadyInput, window: ReportWindow): number[] {
  const times = [
    window.start,
    window.end,
    ...(input.tickets ?? []).flatMap((ticket) => [
      ...ticket.intervals.flatMap((interval) => [
        interval.start,
        interval.end ?? window.end,
      ]),
      ...ticket.dependencies.flatMap((dependency) =>
        dependency.closedAt === null ? [] : [dependency.closedAt],
      ),
    ]),
    ...(input.flow?.runs ?? []).flatMap((run) => [
      run.start,
      run.end ?? window.end,
    ]),
  ];
  return [...new Set(times)]
    .filter((at) => at >= window.start && at <= window.end)
    .toSorted((a, b) => a - b);
}

function readyAt(ticket: ReportReadyTicket, at: number): boolean {
  return ticket.intervals.some(
    (interval) =>
      interval.start <= at && (interval.end === null || interval.end > at),
  );
}

function blockedAt(ticket: ReportReadyTicket, at: number): boolean {
  return ticket.dependencies.some(
    (dependency) => dependency.closedAt === null || dependency.closedAt > at,
  );
}

function knownQueue(
  flow: ReportFlow | undefined,
  window: ReportWindow,
): boolean {
  return (
    flow?.queue != null &&
    flow.runs !== null &&
    flow.runs.every(
      (run) =>
        run.workflowId !== null ||
        run.start >= window.end ||
        (run.end !== null && run.end <= window.start),
    )
  );
}

function addHours(
  waits: Map<number, number>,
  input: { readonly ticket: ReportReadyTicket; readonly hours: number },
): void {
  waits.set(
    input.ticket.issue,
    (waits.get(input.ticket.issue) ?? 0) + input.hours,
  );
}

function activeQueueRuns(flow: ReportFlow | undefined, at: number) {
  return (flow?.runs ?? []).filter(
    (run) =>
      run.workflowId === flow?.queue?.workflowId &&
      run.start <= at &&
      (run.end === null || run.end > at),
  );
}

function addSlice(
  summary: WaitSummary,
  input: {
    readonly tickets: readonly ReportReadyTicket[];
    readonly flow: ReportFlow | undefined;
    readonly at: number;
    readonly hours: number;
  },
): void {
  const ready = input.tickets.filter((ticket) => readyAt(ticket, input.at));
  const eligible = ready.filter((ticket) => !blockedAt(ticket, input.at));
  for (const ticket of ready.filter((ticket) => blockedAt(ticket, input.at)))
    addHours(summary.dependency, { ticket, hours: input.hours });
  const queue = input.flow?.queue;
  if (queue == null || eligible.length === 0) return;
  const active = activeQueueRuns(input.flow, input.at);
  if (active.length < queue.lanes) {
    summary.idle += input.hours;
    for (const ticket of eligible) summary.idleIssues.add(ticket.issue);
    for (const run of active) summary.idleRuns.add(run.runId);
    return;
  }
  for (const ticket of eligible)
    addHours(summary.noLane, { ticket, hours: input.hours });
  for (const run of active) summary.fullRuns.add(run.runId);
}

export function reportReadyData(input: ReadyInput, window: ReportWindow) {
  const tickets = input.tickets;
  if (tickets === null) return { dependency: null, noLane: null, idle: null };
  const times = boundaries(input, window);
  const summary: WaitSummary = {
    dependency: new Map(),
    noLane: new Map(),
    idleIssues: new Set(),
    idleRuns: new Set(),
    fullRuns: new Set(),
    idle: 0,
  };
  for (let index = 0; index < times.length - 1; index += 1) {
    const at = times[index] ?? window.end;
    const hours = ((times[index + 1] ?? at) - at) / 3_600_000;
    addSlice(summary, { tickets, flow: input.flow, at, hours });
  }
  const known = knownQueue(input.flow, window);
  return {
    dependency: waitData({ tickets, waits: summary.dependency }, window),
    noLane: known
      ? waitData(
          { tickets, waits: summary.noLane, runIds: [...summary.fullRuns] },
          window,
        )
      : null,
    idle: known
      ? [
          {
            at: window.start,
            value: summary.idle,
            evidence: {
              issues: [...summary.idleIssues],
              runIds: [...summary.idleRuns],
            },
          },
        ]
      : null,
  };
}

function waitData(
  input: {
    readonly tickets: readonly ReportReadyTicket[];
    readonly waits: ReadonlyMap<number, number>;
    readonly runIds?: readonly string[];
  },
  window: ReportWindow,
): ReportDatum[] {
  const data = input.tickets
    .filter((ticket) => input.waits.has(ticket.issue))
    .map((ticket) => ({
      at: window.start,
      value: input.waits.get(ticket.issue) ?? 0,
      evidence: {
        issue: ticket.issue,
        dependencies: ticket.dependencies.map((dependency) => dependency.issue),
        ...(input.runIds === undefined ? {} : { runIds: input.runIds }),
      },
    }));
  return data.length === 0
    ? [{ at: window.start, value: 0, evidence: { issues: [] } }]
    : data;
}
