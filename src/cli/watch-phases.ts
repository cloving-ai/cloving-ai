import type { WatchPhase } from "./watch-render.ts";

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
const issueWorkflow = "develop-issue";
const issueSteps = [
  { name: "Work tree", operation: "github-prepare" },
  { name: "Claude turn", operation: "claude-turn" },
  { name: "Pull request", operation: "github-open-pr" },
  { name: "Greptile review", operation: "github-wait-review" },
  { name: "Merge", operation: "github-merge" },
];
const verdicts: Readonly<Record<string, string>> = {
  approved: "Approved",
  denied: "Denied",
};
const unfinished = ["failed", "stopped"];

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
      name: "Claude turn",
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

function spans(events: readonly Fields[], workflowId: string): Span[] {
  if (workflowId !== issueWorkflow) return ticketSpans(events);
  const effects = events.filter((event) =>
    [effect.open, effect.close].includes(String(event["type"])),
  );
  return [
    ...admission(events),
    ...issueSteps.map((step) => {
      const own = effects.filter((event) => {
        const operationId = record(event["payload"])["operationId"];
        try {
          const scope: unknown = JSON.parse(String(operationId));
          return Array.isArray(scope) && scope[4] === step.operation;
        } catch {
          return false;
        }
      });
      const last = own.findLast((event) => event["type"] === effect.close);
      const outcome = String(record(last?.["payload"])["outcome"]);
      return {
        name: step.name,
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
  workflowId = "",
): WatchPhase[] {
  const known = events.map(record);
  const steps = spans(known, workflowId);
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
