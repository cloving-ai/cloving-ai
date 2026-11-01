import type { ShownSchedules } from "./schedule-render.ts";
import { activeCommandWait, shownCommandWaits } from "./command-waits.ts";
import type { WorkflowStage, WorkflowStages } from "../workflow-declaration.ts";
import { linksOf } from "../authority/handoff-chain.ts";
import { record } from "../protocol.ts";
import { isInstant } from "../authority/instants.ts";
import {
  pullRequestSteps,
  pullRequestStepOf,
  stageOf,
} from "./watch-phases.ts";
import { sameIssue } from "./watch-pr-identity.ts";
import type {
  WatchCard,
  WatchCompletionMark,
  WatchPullRequest,
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
  if (run.state !== "completed") return null;
  if (run.mergeProof != null)
    return {
      text: `PR merged · #${String(run.mergeProof.number)}`,
      laterRunId: null,
    };
  if (run.outcome !== "blocked") return null;
  const completedAt = eventTime(run, "run.completed");
  const later = candidates
    .filter(
      (candidate) =>
        sameIssue(run.issueIdentity, candidate.issueIdentity) &&
        candidate.mergeProof != null &&
        candidate.runId !== run.runId &&
        candidate.state === "completed" &&
        candidate.outcome === "handoff_requested" &&
        candidate.ticketStatus !== "partial" &&
        candidate.issueUpdate !== "failed",
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
    : { text: "Ticket completed by later run", laterRunId: later.runId };
}

export function activeRun(state: string): boolean {
  return !terminalStates.includes(state);
}

export function recentRun(latestAt: string | null, now: string): boolean {
  const age = Date.parse(now) - Date.parse(latestAt ?? "");
  return age >= 0 && age <= weekMilliseconds;
}

export function stagesFor(
  metadata: WorkflowStages | undefined,
  workflowId: string,
): readonly WorkflowStage[] | undefined {
  return metadata !== undefined && Object.hasOwn(metadata, workflowId)
    ? metadata[workflowId]
    : undefined;
}

function stepNames(
  workflow: { readonly pullRequest?: WatchPullRequest | null },
  stages?: readonly WorkflowStage[],
): readonly string[] {
  if (stages !== undefined)
    return [...stages.map((stage) => stage.label), "Other"];
  return workflow.pullRequest != null
    ? pullRequestSteps.map((step) => step.name)
    : ["Agent turn", "Your review"];
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

function stepName(
  event: unknown,
  workflow: { readonly pullRequest?: WatchPullRequest | null },
): string | undefined {
  const type = record(event)?.["type"];
  if (workflow.pullRequest == null && type === "gate.opened")
    return "Your review";
  if (type !== "effect.requested") return undefined;
  if (workflow.pullRequest == null) return "Agent turn";
  return pullRequestStepOf(event)?.name;
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

function declaredStep(
  events: readonly unknown[],
  stages: readonly WorkflowStage[],
): WatchStep {
  const event = events
    .filter((item) =>
      ["effect.requested", "gate.opened"].includes(
        String(record(item)?.["type"]),
      ),
    )
    .toSorted(
      (first, second) =>
        Number(record(second)?.["sequence"]) -
        Number(record(first)?.["sequence"]),
    )[0];
  const stage = stageOf(event, stages);
  return { name: stage?.label ?? "Other", startedAt: startedAt(event) };
}

export function currentStepOf(
  events: readonly unknown[],
  workflow: {
    readonly pullRequest?: WatchPullRequest | null;
    readonly stages: readonly WorkflowStage[] | undefined;
  },
): WatchStep {
  const { stages } = workflow;
  if (stages !== undefined) return declaredStep(events, stages);
  const event = chronological(events).findLast(
    (item) => stepName(item, workflow) !== undefined,
  );
  return {
    name: stepName(event, workflow) ?? stepNames(workflow)[0] ?? "Agent turn",
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

function pullRequestCardDetails(
  run: WatchRun,
): Pick<WatchCard, "round" | "greptileScore" | "pullRequestNumber"> {
  return {
    round: run.pullRequest !== null ? run.round : null,
    greptileScore: run.reviews.at(-1)?.score ?? null,
    pullRequestNumber: run.pullRequest?.number ?? null,
  };
}

function cardOf(run: WatchRun, runs: readonly WatchRun[]): WatchCard {
  return {
    runId: run.runId,
    ...(run.scheduled === undefined ? {} : { scheduled: run.scheduled }),
    commandWaits: run.commandWaits ?? [],
    spent: run.spent,
    limit: run.limit,
    title: run.title,
    ...linksOf(run),
    ...(run.awaitedRunId == null ? {} : { awaitedRunId: run.awaitedRunId }),
    completionMark: completionMarkOf(run, runs),
    pullRequestObservation: null,
    claudeCostUsd: run.claudeCostUsd,
    estimatedCostUsd: run.estimatedCostUsd,
    usage: run.usage,
    currentStep: activeRun(run.state) ? run.currentStep : null,
    endedAt: activeRun(run.state) ? null : run.latestAt,
    decisionWaiting: run.decisions.length > 0,
    ...pullRequestCardDetails(run),
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
  readonly schedules?: ShownSchedules;
  readonly workflows: readonly string[];
  readonly workflowStages?: WorkflowStages;
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
    waiting:
      (Array.isArray(pending) && pending.length > 0) ||
      typeof fields?.["awaitedRunId"] === "string" ||
      activeCommandWait(shownCommandWaits(fields?.["commandWaits"])),
    latestAt: typeof latest === "string" ? latest : null,
  };
}

function runSummaryOf(run: WatchRun): ReturnType<typeof summaryOf> {
  return {
    state: run.state,
    waiting:
      run.decisions.length > 0 ||
      run.awaitedRunId != null ||
      activeCommandWait(run.commandWaits ?? []),
    latestAt: run.latestAt,
  };
}

export function boardsOf(
  inputs: BoardInputs,
  runs: readonly WatchRun[],
): WatchWorkflow[] {
  const schedules = inputs.schedules ?? [];
  return inputs.workflows.map((workflowId) => {
    const own = runs.filter((run) => run.workflowId === workflowId);
    const schedule =
      "status" in schedules
        ? undefined
        : schedules.find((entry) => entry.workflowId === workflowId);
    const summaries =
      inputs.summaries === undefined
        ? own.map(runSummaryOf)
        : inputs.summaries
            .filter((value) => record(value)?.["workflowId"] === workflowId)
            .map(summaryOf);
    const names = [
      ...stepNames(
        {
          pullRequest:
            own.find((run) => run.pullRequest !== null)?.pullRequest ?? null,
        },
        stagesFor(inputs.workflowStages, workflowId),
      ),
      ...own
        .filter((run) => activeRun(run.state))
        .map((run) => run.currentStep.name),
      "Done",
      "Stopped",
    ];
    const columns = [...new Set(names)].map((name) => {
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
    });
    return {
      workflowId,
      ...(schedule === undefined ? {} : { schedule }),
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
