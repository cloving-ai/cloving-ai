import { activeCommandWait } from "./command-waits.ts";
import { record, type Fields } from "../protocol.ts";
import type { PrIdentity } from "./watch-pr-identity.ts";
import type {
  WatchLamp,
  WatchReady,
  WatchRun,
  WatchStation,
  WatchTile,
  WatchToken,
} from "./watch-render.ts";

const urgency: readonly WatchLamp[] = [
  "stopped",
  "needs-you",
  "waiting",
  "running",
];

export function lampOf(run: WatchRun): WatchLamp {
  if (run.state === "paused") return "stopped";
  if (run.state === "waiting_gate" || run.decisions.length > 0)
    return "needs-you";
  if (
    run.state === "queued" ||
    run.awaitedRunId != null ||
    activeCommandWait(run.commandWaits ?? [])
  )
    return "waiting";
  return "running";
}

function workerOf(run: WatchRun, lamp: WatchLamp): string {
  if (lamp === "needs-you") return "Y";
  const harness = run.turns.findLast(
    (turn) => turn.harness !== undefined,
  )?.harness;
  return harness?.charAt(0).toUpperCase() ?? "·";
}

function ticketLabel(known: {
  readonly ticketId: string | null;
  readonly issue: PrIdentity | null;
}): string | null {
  if (known.issue !== null) return `#${String(known.issue.number)}`;
  if (known.ticketId === null) return null;
  return /^\d+$/.test(known.ticketId) ? `#${known.ticketId}` : known.ticketId;
}

function labelOf(
  status: Fields,
  known: Parameters<typeof ticketLabel>[0],
): string | null {
  if (!Object.hasOwn(status, "label")) return ticketLabel(known);
  return typeof status["label"] === "string" ? status["label"] : null;
}

export function shownName(
  status: Fields,
  known: Parameters<typeof ticketLabel>[0],
): Pick<WatchRun, "label" | "titleSource" | "labelSource" | "manualName"> {
  const { titleSource, labelSource } = status;
  const manual = titleSource === "manual" || labelSource === "manual";
  return {
    label: labelOf(status, known),
    titleSource: typeof titleSource === "string" ? titleSource : null,
    labelSource: typeof labelSource === "string" ? labelSource : null,
    ...(manual ? { manualName: true } : {}),
  };
}

function labelText(run: WatchRun): string | null {
  return run.label ?? null;
}

function tokenOf(run: WatchRun): WatchToken {
  const lamp = lampOf(run);
  return {
    runId: run.runId,
    title: run.title,
    lamp,
    worker: workerOf(run, lamp),
    ticket: labelText(run),
    pullRequestNumber: run.pullRequest?.number ?? null,
    startedAt: run.currentStep.startedAt,
  };
}

function tokenOrder(first: WatchToken, second: WatchToken): number {
  return (
    urgency.indexOf(first.lamp) - urgency.indexOf(second.lamp) ||
    Date.parse(first.startedAt ?? "") - Date.parse(second.startedAt ?? "") ||
    0
  );
}

export function stationsOf(line: {
  readonly names: readonly string[];
  readonly runs: readonly WatchRun[];
}): WatchStation[] {
  const names = [
    ...new Set([
      ...line.names,
      ...line.runs.map((run) => run.currentStep.name),
    ]),
  ];
  return names.map((name) => {
    const tokens = line.runs
      .filter((run) => run.currentStep.name === name)
      .map(tokenOf)
      .toSorted(tokenOrder);
    return {
      name,
      lamp:
        urgency.find((lamp) => tokens.some((token) => token.lamp === lamp)) ??
        null,
      tokens,
    };
  });
}

function shownReady(value: unknown): WatchReady | undefined {
  const ready = record(value);
  const { count, oldestAt, failure } = ready ?? {};
  if (typeof failure === "string") return { failure };
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
    return undefined;
  if (oldestAt !== null && typeof oldestAt !== "string") return undefined;
  return { count, oldestAt };
}

export function readyOf(
  queue: Fields | undefined,
  workflowId: string,
): { readonly ready?: WatchReady } {
  if (queue?.["workflowId"] !== workflowId) return {};
  const ready = shownReady(queue["ready"]);
  return ready === undefined ? {} : { ready };
}

function eventAt(run: WatchRun, type: string): string | undefined {
  return run.events.find((event) => event.type === type)?.recordedAt;
}

function tilesOf(run: WatchRun): WatchTile[] {
  const startedAt = eventAt(run, "run.created");
  const completedAt = eventAt(run, "run.completed");
  if (
    run.state !== "completed" ||
    run.outcome === "blocked" ||
    run.ticketStatus === "partial" ||
    startedAt === undefined ||
    completedAt === undefined
  )
    return [];
  return [
    {
      runId: run.runId,
      workflowId: run.workflowId,
      ticket: labelText(run),
      pullRequestNumber: run.pullRequest?.number ?? null,
      title: run.title ?? run.runId,
      startedAt,
      completedAt,
      claudeCostUsd: run.claudeCostUsd,
      estimatedCostUsd: run.estimatedCostUsd,
      demo: run.demo ?? null,
    },
  ];
}

export function completedOf(
  runs: readonly WatchRun[],
  since: number,
): WatchTile[] {
  return runs
    .flatMap(tilesOf)
    .filter((tile) => Date.parse(tile.completedAt) >= since)
    .toSorted(
      (first, second) =>
        Date.parse(second.completedAt) - Date.parse(first.completedAt),
    );
}
