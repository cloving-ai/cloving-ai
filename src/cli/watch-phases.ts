import type { WorkflowStage } from "../workflow-declaration.ts";
import type { WatchPhase, WatchPullRequest } from "./watch-render.ts";

type Fields = Readonly<Record<string, unknown>>;

interface Span {
  readonly name: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly ending: string;
}

const endings = [
  { type: "run.completed", name: "Completed", state: "done" },
  { type: "run.failed", name: "Failed", state: "failed" },
  { type: "run.cancelled", name: "Dropped", state: "failed" },
];

const review = { open: "gate.opened", close: "gate.decided" };
const effect = { open: "effect.requested", close: "effect.reported" };
export const pullRequestSteps = [
  { name: "Work tree", operation: "github-prepare" },
  { name: "Agent turn", operation: "claude-turn" },
  { name: "Pull request", operation: "github-open-pr" },
  { name: "Code review", operation: "github-wait-review" },
  { name: "Merge", operation: "github-merge" },
];
const verdicts: Readonly<Record<string, string>> = {
  approved: "Approved",
  denied: "Denied",
};
const unfinished = ["failed", "stopped"];
const roundOperations = ["claude-turn", "github-open-pr", "github-wait-review"];

function record(value: unknown): Fields {
  return typeof value === "object" && value !== null ? { ...value } : {};
}

function timeOf(event: Fields | undefined): string | null {
  const recordedAt = event?.["recordedAt"];
  return typeof recordedAt === "string" ? recordedAt : null;
}

function firstAt(events: readonly Fields[], type: string): string | null {
  return timeOf(events.find((event) => event["type"] === type));
}

function closedAt(
  events: readonly Fields[],
  pair: { readonly open: string; readonly close: string },
): string | null {
  const types = events.map((event) => event["type"]);
  const closed = types.lastIndexOf(pair.close);
  return closed > types.lastIndexOf(pair.open) ? timeOf(events[closed]) : null;
}

export function decisionOf(events: readonly unknown[]): string {
  const known = events.map(record);
  const types = known.map((event) => event["type"]);
  const closed = types.lastIndexOf(review.close);
  if (closed <= types.lastIndexOf(review.open)) return "";
  const decision = record(known[closed]?.["payload"])["decision"];
  return typeof decision === "string" ? decision : "";
}

function admission(events: readonly Fields[]): Span[] {
  const created = firstAt(events, "run.created");
  const started = firstAt(events, "run.started");
  return [
    { name: "Admitted", startedAt: created, endedAt: created, ending: "done" },
    { name: "Started", startedAt: started, endedAt: started, ending: "done" },
  ];
}

function ticketSpans(events: readonly Fields[]): Span[] {
  const decision = decisionOf(events);
  return [
    ...admission(events),
    {
      name: "Agent turn",
      startedAt: firstAt(events, effect.open),
      endedAt: closedAt(events, effect),
      ending: "done",
    },
    {
      name: verdicts[decision] ?? "Your review",
      startedAt: firstAt(events, review.open),
      endedAt: closedAt(events, review),
      ending: decision === "denied" ? "failed" : "done",
    },
  ];
}

function operationOf(event: Fields | undefined): readonly unknown[] {
  const operationId = record(event?.["payload"])["operationId"];
  try {
    const scope: unknown = JSON.parse(String(operationId));
    return Array.isArray(scope) ? scope : [];
  } catch {
    return [];
  }
}

export function pullRequestStepOf(event: unknown) {
  const scope = operationOf(record(event));
  return pullRequestSteps.find(
    (step) =>
      step.operation === scope[4] ||
      (step.name === "Code review" && scope[3] === "review") ||
      (step.name === "Merge" && scope[3] === "merge"),
  );
}

function stepEffects(
  events: readonly Fields[],
  context: {
    readonly step: (typeof pullRequestSteps)[number];
    readonly round: number;
  },
): readonly Fields[] {
  const { step, round } = context;
  const repeated = roundOperations.includes(step.operation);
  const currentTurn = events.findLastIndex(
    (event) =>
      event["type"] === effect.open && operationOf(event)[4] === "claude-turn",
  );
  const requested = new Set(
    events
      .slice(currentTurn + 1)
      .filter((event) => event["type"] === effect.open)
      .map((event) => record(event["payload"])["operationId"]),
  );
  return events.filter((event) => {
    if (pullRequestStepOf(event) !== step) return false;
    if (!repeated) return true;
    const scope = operationOf(event);
    return roundOperations.includes(String(scope[4]))
      ? scope[1] === round
      : requested.has(record(event["payload"])["operationId"]);
  });
}

export function stageOf(
  event: unknown,
  stages: readonly WorkflowStage[],
): WorkflowStage | undefined {
  const fields = record(event);
  if ([effect.open, effect.close].includes(String(fields["type"]))) {
    const operation = operationOf(fields)[4];
    return stages.find((stage) =>
      stage.operations?.some((name) => name === operation),
    );
  }
  const payload = record(fields["payload"]);
  return (
    stages.find((stage) =>
      stage.gateIds?.some((name) => name === payload["gateId"]),
    ) ??
    stages.find((stage) =>
      stage.gateKinds?.some((name) => name === payload["gateKind"]),
    )
  );
}

function declaredSpans(
  events: readonly Fields[],
  stages: readonly WorkflowStage[],
): Span[] {
  return stages.map((stage) => {
    const index = events.findLastIndex(
      (event) =>
        [effect.open, review.open].includes(String(event["type"])) &&
        stageOf(event, stages) === stage,
    );
    const opening = events[index];
    const pair = opening?.["type"] === review.open ? review : effect;
    const identity = pair === review ? "gateId" : "operationId";
    const key = record(opening?.["payload"])[identity];
    const closing = events
      .slice(index + 1)
      .findLast(
        (event) =>
          event["type"] === pair.close &&
          key !== undefined &&
          record(event["payload"])[identity] === key,
      );
    const payload = record(closing?.["payload"]);
    const failed =
      unfinished.includes(String(payload["outcome"])) ||
      payload["decision"] === "denied";
    return {
      name: stage.label,
      startedAt: timeOf(opening),
      endedAt: timeOf(closing),
      ending: failed ? "failed" : "done",
    };
  });
}

function currentRound(events: readonly Fields[]): number {
  const requested = events.findLast(
    (event) =>
      event["type"] === effect.open && operationOf(event)[4] === "claude-turn",
  );
  const round = operationOf(requested)[1];
  return typeof round === "number" ? round : 1;
}

function spans(
  events: readonly Fields[],
  workflow: {
    readonly pullRequest?: WatchPullRequest | null;
    readonly stages?: readonly WorkflowStage[] | undefined;
  },
): Span[] {
  if (workflow.stages !== undefined)
    return [...admission(events), ...declaredSpans(events, workflow.stages)];
  if (workflow.pullRequest == null) return ticketSpans(events);
  const effects = events.filter((event) =>
    [effect.open, effect.close].includes(String(event["type"])),
  );
  const round = currentRound(effects);
  return [
    ...admission(events),
    ...pullRequestSteps.map((step) => {
      const repeated = roundOperations.includes(step.operation);
      const own = stepEffects(effects, { step, round });
      const last = own.findLast((event) => event["type"] === effect.close);
      const outcome = String(record(last?.["payload"])["outcome"]);
      return {
        name:
          repeated && round > 1
            ? `${step.name}, round ${String(round)}`
            : step.name,
        startedAt: firstAt(own, effect.open),
        endedAt: closedAt(own, effect),
        ending: unfinished.includes(outcome) ? "failed" : "done",
      };
    }),
  ];
}

function phase(span: Span, open: string): WatchPhase {
  const { ending, ...shown } = span;
  if (span.endedAt !== null) return { ...shown, state: ending };
  return { ...shown, state: span.startedAt === null ? "pending" : open };
}

function ends(events: readonly Fields[]): WatchPhase[] {
  return endings.flatMap(({ type, name, state }) => {
    const event = events.findLast((item) => item["type"] === type);
    if (event === undefined) return [];
    const recordedAt = timeOf(event);
    return [{ name, state, startedAt: recordedAt, endedAt: recordedAt }];
  });
}

function advanced(phases: readonly WatchPhase[]): WatchPhase[] {
  const next = phases.findLastIndex((item) => item.state === "done") + 1;
  const idle = phases.every((item) => item.state !== "active");
  return phases.map((item, index) =>
    idle && next > 0 && index === next && item.state === "pending"
      ? { ...item, state: "active" }
      : item,
  );
}

export function phasesOf(
  events: readonly unknown[],
  workflow: {
    readonly pullRequest?: WatchPullRequest | null;
    readonly stages?: readonly WorkflowStage[] | undefined;
  } = {},
): WatchPhase[] {
  const known = events.map(record);
  const steps = spans(known, workflow);
  const [end] = ends(known);
  if (end !== undefined)
    return [...steps.map((span) => phase(span, "failed")), end];
  const open = {
    name: "Completed",
    startedAt: null,
    endedAt: null,
    ending: "done",
  };
  return advanced([...steps, open].map((span) => phase(span, "active")));
}
