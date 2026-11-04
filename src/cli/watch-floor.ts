import { activeCommandWait } from "./command-waits.ts";
import { record, type Fields } from "../protocol.ts";
import type {
  WatchLamp,
  WatchReady,
  WatchRun,
  WatchStation,
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

function ticketOf(run: WatchRun): string {
  if (run.issueIdentity != null) return `#${String(run.issueIdentity.number)}`;
  if (run.ticketId === null) return "Draft";
  return /^\d+$/.test(run.ticketId) ? `#${run.ticketId}` : run.ticketId;
}

function tokenOf(run: WatchRun): WatchToken {
  const lamp = lampOf(run);
  return {
    runId: run.runId,
    title: run.title,
    lamp,
    worker: workerOf(run, lamp),
    ticket: ticketOf(run),
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
