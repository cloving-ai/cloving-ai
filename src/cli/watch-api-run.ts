import type {
  WatchDecision,
  WatchEvent,
  WatchPhase,
  WatchReview,
  WatchRun,
  WatchTurn,
} from "./watch-render.ts";

export interface ApiRun {
  readonly runId: string;
  readonly workflowId: string;
  readonly ticketId: string | null;
  readonly title: string | null;
  readonly titleSource: string | null;
  readonly label: string | null;
  readonly labelSource: string | null;
  readonly state: string;
  readonly outcome: string | null;
  readonly currentStep: {
    readonly name: string;
    readonly startedAt: string | null;
  };
  readonly latestAt: string | null;
  readonly pullRequest: {
    readonly number: number;
    readonly url: string;
  } | null;
  readonly estimatedCostUsd: number | null;
}

interface ApiDecision {
  readonly decisionId: string;
  readonly type: string;
  readonly prompt: string;
}

interface ApiTurn {
  readonly key: string;
  readonly operationId: string;
  readonly harness: string | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly outcome: string;
  readonly estimatedCostUsd: number | null;
  readonly summary: string;
}

export interface ApiRunDetail extends ApiRun {
  readonly code: string;
  readonly detail: string;
  readonly round: number;
  readonly spent: number | null;
  readonly limit: number | null;
  readonly decisions: readonly ApiDecision[];
  readonly phases: readonly WatchPhase[];
  readonly reviews: readonly WatchReview[];
  readonly mergeCommit: string | null;
  readonly turns: readonly ApiTurn[];
}

export function runOf(run: WatchRun): ApiRun {
  const { pullRequest, currentStep } = run;
  return {
    runId: run.runId,
    workflowId: run.workflowId,
    ticketId: run.ticketId,
    title: run.title,
    titleSource: run.titleSource ?? null,
    label: run.label ?? null,
    labelSource: run.labelSource ?? null,
    state: run.state,
    outcome: run.outcome,
    currentStep: { name: currentStep.name, startedAt: currentStep.startedAt },
    latestAt: run.latestAt,
    pullRequest:
      pullRequest === null
        ? null
        : { number: pullRequest.number, url: pullRequest.url },
    estimatedCostUsd: run.estimatedCostUsd,
  };
}

function decisionOf(decision: WatchDecision): ApiDecision {
  return {
    decisionId: decision.decisionId,
    type: decision.type,
    prompt: decision.prompt,
  };
}

function phaseOf(phase: WatchPhase): WatchPhase {
  return {
    name: phase.name,
    state: phase.state,
    startedAt: phase.startedAt,
    endedAt: phase.endedAt,
  };
}

function reviewOf(review: WatchReview): WatchReview {
  return { round: review.round, commit: review.commit, score: review.score };
}

function turnOf(turn: WatchTurn): ApiTurn {
  return {
    key: turn.key,
    operationId: turn.operationId,
    harness: turn.harness ?? null,
    startedAt: turn.startedAt,
    endedAt: turn.endedAt,
    outcome: turn.outcome,
    estimatedCostUsd: turn.estimatedCostUsd,
    summary: turn.summary,
  };
}

export function runDetailOf(run: WatchRun): ApiRunDetail {
  return {
    ...runOf(run),
    code: run.code,
    detail: run.detail,
    round: run.round,
    spent: run.spent,
    limit: run.limit,
    decisions: run.decisions.map(decisionOf),
    phases: run.phases.map(phaseOf),
    reviews: run.reviews.map(reviewOf),
    mergeCommit: run.mergeCommit,
    turns: run.turns.map(turnOf),
  };
}

function eventOf(event: WatchEvent): WatchEvent {
  return {
    sequence: event.sequence,
    type: event.type,
    recordedAt: event.recordedAt,
  };
}

export function eventsAfter(
  run: WatchRun,
  after: number,
): readonly WatchEvent[] {
  return run.events.filter((event) => event.sequence > after).map(eventOf);
}

function instant(latestAt: string | null): number {
  const time = Date.parse(latestAt ?? "");
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}

function codeOrder(first: string, second: string): number {
  if (first === second) return 0;
  return first < second ? -1 : 1;
}

export interface RunKey {
  readonly latestAt: string | null;
  readonly runId: string;
}

export function runOrder(first: RunKey, second: RunKey): number {
  const earlier = instant(first.latestAt);
  const later = instant(second.latestAt);
  if (earlier !== later) return earlier > later ? -1 : 1;
  return codeOrder(first.runId, second.runId);
}

export function cursorOf(run: RunKey): string {
  return Buffer.from(JSON.stringify([run.latestAt, run.runId])).toString(
    "base64url",
  );
}

function parsedJson(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    return null;
  }
}

export function keyOf(cursor: string): RunKey | null {
  const value = parsedJson(Buffer.from(cursor, "base64url").toString("utf8"));
  const entries = Array.isArray(value)
    ? value.map((item: unknown) => item)
    : [];
  const [latestAt, runId] = entries;
  if (entries.length !== 2 || typeof runId !== "string") return null;
  if (latestAt !== null && typeof latestAt !== "string") return null;
  const key = { latestAt, runId };
  return cursorOf(key) === cursor ? key : null;
}
