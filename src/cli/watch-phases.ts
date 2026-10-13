import type { WatchPhase } from "./watch-render.ts";

type Fields = Readonly<Record<string, unknown>>;

interface Span {
  readonly name: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
}

const endings = [
  { type: "run.completed", name: "Completed", state: "done" },
  { type: "run.failed", name: "Failed", state: "failed" },
  { type: "run.cancelled", name: "Dropped", state: "failed" },
];

const review = { open: "gate.opened", close: "gate.decided" };
const verdicts: Readonly<Record<string, string>> = {
  approved: "Approved",
  denied: "Denied",
};

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

function spans(events: readonly Fields[]): Span[] {
  const created = firstAt(events, "run.created");
  const started = firstAt(events, "run.started");
  const turn = { open: "effect.requested", close: "effect.reported" };
  return [
    { name: "Admitted", startedAt: created, endedAt: created },
    { name: "Started", startedAt: started, endedAt: started },
    {
      name: "Claude turn",
      startedAt: firstAt(events, turn.open),
      endedAt: closedAt(events, turn),
    },
    {
      name: verdicts[decisionOf(events)] ?? "Your review",
      startedAt: firstAt(events, review.open),
      endedAt: closedAt(events, review),
    },
  ];
}

function phase(span: Span, open: string): WatchPhase {
  if (span.endedAt !== null)
    return { ...span, state: span.name === "Denied" ? "failed" : "done" };
  return { ...span, state: span.startedAt === null ? "pending" : open };
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
    idle && next > 0 && index === next ? { ...item, state: "active" } : item,
  );
}

export function phasesOf(events: readonly unknown[]): WatchPhase[] {
  const known = events.map(record);
  const steps = spans(known);
  const [end] = ends(known);
  if (end !== undefined)
    return [...steps.map((span) => phase(span, "failed")), end];
  const open = { name: "Completed", startedAt: null, endedAt: null };
  return advanced([...steps, open].map((span) => phase(span, "active")));
}
