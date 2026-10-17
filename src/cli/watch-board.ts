import { record } from "../protocol.ts";
import { isInstant } from "../authority/instants.ts";
import { issueSteps } from "./watch-phases.ts";
import type {
  WatchCard,
  WatchCompletionMark,
  WatchRun,
  WatchStep,
  WatchWorkflow,
} from "./watch-render.ts";

const weekMilliseconds = 7 * 24 * 60 * 60 * 1000;
const terminalStates = ["completed", "failed", "cancelled"];

function eventTime(run: WatchRun, type: string): number {
  const recordedAt = run.events.find(
    (event) => event.type === type,
  )?.recordedAt;
  return isInstant(recordedAt) ? Date.parse(recordedAt) : NaN;
}

export function completionMarkOf(
  run: WatchRun,
  candidates: readonly WatchRun[],
): WatchCompletionMark | null {
  if (
    run.workflowId !== "develop-issue" ||
    run.state !== "completed" ||
    run.outcome !== "blocked"
  )
    return null;
  const completedAt = eventTime(run, "run.completed");
  const later = candidates
    .filter(
      (candidate) =>
        typeof run.ticketId === "string" &&
        run.ticketId !== "" &&
        candidate.ticketId === run.ticketId &&
        candidate.runId !== run.runId &&
        candidate.workflowId === "develop-issue" &&
        candidate.state === "completed" &&
        candidate.outcome === "handoff_requested",
    )
    .map((candidate) => ({
      runId: candidate.runId,
      createdAt: eventTime(candidate, "run.created"),
    }))
    .filter((candidate) => candidate.createdAt > completedAt)
    .toSorted(
      (first, second) =>
        first.createdAt - second.createdAt ||
        (first.runId < second.runId ? -1 : 1),
    )[0];
  return later === undefined
    ? { text: "Needs attention", laterRunId: null }
    : { text: "Done in a later run", laterRunId: later.runId };
}

export function activeRun(state: string): boolean {
  return !terminalStates.includes(state);
}

export function recentRun(latestAt: string | null, now: string): boolean {
  const age = Date.parse(now) - Date.parse(latestAt ?? "");
  return age >= 0 && age <= weekMilliseconds;
}

function stepNames(workflowId: string): readonly string[] {
  return workflowId === "develop-issue"
    ? issueSteps.map((step) => step.name)
    : ["Claude turn", "Your review"];
}

function operationOf(event: unknown): readonly unknown[] {
  const payload = record(record(event)?.["payload"]);
  try {
    const operation: unknown = JSON.parse(String(payload?.["operationId"]));
    return Array.isArray(operation) ? operation : [];
  } catch {
    return [];
  }
}

function stepName(event: unknown, workflowId: string): string | undefined {
  const type = record(event)?.["type"];
  if (workflowId !== "develop-issue" && type === "gate.opened")
    return "Your review";
  if (type !== "effect.requested") return undefined;
  if (workflowId !== "develop-issue") return "Claude turn";
  return issueSteps.find((step) => step.operation === operationOf(event)[4])
    ?.name;
}

function startedAt(event: unknown): string | null {
  const value = record(event)?.["recordedAt"];
  return typeof value === "string" ? value : null;
}

function chronological(events: readonly unknown[]): readonly unknown[] {
  return events.toSorted(
    (first, second) =>
      Date.parse(startedAt(first) ?? "") - Date.parse(startedAt(second) ?? ""),
  );
}

export function currentStepOf(
  events: readonly unknown[],
  workflowId: string,
): WatchStep {
  const event = chronological(events).findLast(
    (item) => stepName(item, workflowId) !== undefined,
  );
  return {
    name:
      stepName(event, workflowId) ?? stepNames(workflowId)[0] ?? "Claude turn",
    startedAt: startedAt(event),
  };
}

export function roundOf(events: readonly unknown[]): number {
  const event = chronological(events).findLast(
    (item) =>
      record(item)?.["type"] === "effect.requested" &&
      operationOf(item)[4] === "claude-turn",
  );
  const round = operationOf(event)[1];
  return typeof round === "number" ? round : 1;
}

function columnOf(run: WatchRun, now: string): string | null {
  if (activeRun(run.state)) return run.currentStep.name;
  if (!recentRun(run.latestAt, now)) return null;
  if (run.state !== "completed" || run.outcome === "blocked") return "Stopped";
  return run.outcome === "handoff_requested" ? "Done" : null;
}

function cardOf(run: WatchRun, runs: readonly WatchRun[]): WatchCard {
  const issue = run.workflowId === "develop-issue";
  return {
    runId: run.runId,
    title: run.title,
    completionMark: completionMarkOf(run, runs),
    pullRequestObservation: null,
    claudeCostUsd: run.claudeCostUsd,
    usage: run.usage,
    currentStep: activeRun(run.state) ? run.currentStep : null,
    endedAt: activeRun(run.state) ? null : run.latestAt,
    decisionWaiting: run.decisions.length > 0,
    round: issue ? run.round : null,
    greptileScore: issue ? (run.reviews.at(-1)?.score ?? null) : null,
    pullRequestNumber: issue ? (run.pullRequest?.number ?? null) : null,
  };
}

function stepOrder(first: WatchCard, second: WatchCard): number {
  const waiting =
    Number(second.decisionWaiting) - Number(first.decisionWaiting);
  if (waiting !== 0) return waiting;
  return (
    Date.parse(first.currentStep?.startedAt ?? "1970-01-01") -
    Date.parse(second.currentStep?.startedAt ?? "1970-01-01")
  );
}

interface BoardInputs {
  readonly workflows: readonly string[];
  readonly updatedAt: string;
  readonly summaries?: readonly unknown[];
  readonly completionCandidates?: readonly WatchRun[];
}

function latestTime(times: readonly (string | null)[]): string | null {
  return (
    times
      .filter((time) => time !== null)
      .toSorted((first, second) => Date.parse(second) - Date.parse(first))[0] ??
    null
  );
}

function summaryOf(value: unknown): {
  readonly state: string;
  readonly waiting: boolean;
  readonly latestAt: string | null;
} {
  const fields = record(value);
  const pending = fields?.["pendingDecisions"];
  const latest = fields?.["latestAt"];
  return {
    state: String(fields?.["state"]),
    waiting: Array.isArray(pending) && pending.length > 0,
    latestAt: typeof latest === "string" ? latest : null,
  };
}

export function boardsOf(
  inputs: BoardInputs,
  runs: readonly WatchRun[],
): WatchWorkflow[] {
  return inputs.workflows.map((workflowId) => {
    const own = runs.filter((run) => run.workflowId === workflowId);
    const summaries =
      inputs.summaries === undefined
        ? own.map((run) => ({
            state: run.state,
            waiting: run.decisions.length > 0,
            latestAt: run.latestAt,
          }))
        : inputs.summaries
            .filter((value) => record(value)?.["workflowId"] === workflowId)
            .map(summaryOf);
    const columns = [...stepNames(workflowId), "Done", "Stopped"].map(
      (name) => {
        const cards = own
          .filter((run) => columnOf(run, inputs.updatedAt) === name)
          .map((run) => cardOf(run, inputs.completionCandidates ?? runs));
        return {
          name,
          cards: ["Done", "Stopped"].includes(name)
            ? cards
                .toSorted(
                  (first, second) =>
                    Date.parse(second.endedAt ?? "") -
                    Date.parse(first.endedAt ?? ""),
                )
                .slice(0, 20)
            : cards.toSorted(stepOrder),
        };
      },
    );
    return {
      workflowId,
      activeCount: summaries.filter((run) => activeRun(run.state)).length,
      waitingCount: summaries.filter((run) => run.waiting).length,
      latestAt: latestTime(summaries.map((run) => run.latestAt)),
      columns,
    };
  });
}

export function startWorkflowOf(
  workflows: readonly WatchWorkflow[],
): string | null {
  const waiting = workflows.filter((workflow) => workflow.waitingCount > 0);
  return (
    (waiting.length > 0 ? waiting : workflows).toSorted(
      (first, second) =>
        Date.parse(second.latestAt ?? "1970-01-01") -
        Date.parse(first.latestAt ?? "1970-01-01"),
    )[0]?.workflowId ?? null
  );
}
