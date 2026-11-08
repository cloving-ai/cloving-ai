import type { Ticket } from "./effects.ts";

export interface Draft {
  readonly number: number;
  readonly title: string;
  readonly lines: readonly string[];
  readonly blockers: readonly number[];
  readonly outside: boolean;
}

export type PlanCheck =
  | { readonly kind: "plan"; readonly order: readonly Draft[] }
  | { readonly kind: "cycle"; readonly cycle: readonly number[] };

interface Heading {
  readonly number: number;
  readonly title: string;
}

function headingOf(line: string): Heading | null {
  const match = /^# Draft ([1-9]\d*): (\S.*)$/.exec(line);
  if (match === null) return null;
  return { number: Number(match[1]), title: String(match[2]).trim() };
}

export function dependencyRange(lines: readonly string[]): {
  readonly start: number;
  readonly end: number;
} {
  const heading = lines.findIndex((line) => /^## Dependencies\s*$/.test(line));
  if (heading === -1) return { start: lines.length, end: lines.length };
  const start = heading + 1;
  const after = lines.slice(start).findIndex((line) => /^#{1,2} /.test(line));
  return { start: start, end: after === -1 ? lines.length : start + after };
}

export function dependencyLines(lines: readonly string[]): readonly string[] {
  const range = dependencyRange(lines);
  return lines.slice(range.start, range.end);
}

function draftOf(heading: Heading, lines: readonly string[]): Draft {
  const section = dependencyLines(lines).join("\n");
  const blockers = Array.from(
    section.matchAll(/\bdraft\s+([1-9]\d*)\b/gi),
    (match) => Number(match[1]),
  );
  return {
    number: heading.number,
    title: heading.title,
    lines: lines,
    blockers: Array.from(new Set(blockers)).sort((left, right) => left - right),
    outside: /#[1-9]\d*\b/.test(section),
  };
}

export function planDrafts(text: string): readonly Draft[] {
  const lines = text.split(/\r?\n/);
  const starts = lines.flatMap((line, index) =>
    headingOf(line) === null ? [] : [index],
  );
  const first = starts[0] ?? lines.length;
  if (
    starts.length === 0 ||
    starts.length > 12 ||
    lines.slice(0, first).some((line) => line.trim() !== "")
  )
    throw new Error("invalid-plan");
  const drafts = starts.map((start, index) => {
    const heading = headingOf(lines.at(start) ?? "");
    if (heading?.number !== index + 1) throw new Error("invalid-plan");
    const end = starts.at(index + 1) ?? lines.length;
    return draftOf(heading, lines.slice(start + 1, end));
  });
  if (
    drafts.some((draft) =>
      draft.blockers.some((blocker) => blocker > drafts.length),
    )
  )
    throw new Error("invalid-plan");
  return drafts;
}

function nextDraft(
  order: readonly Draft[],
  rest: readonly Draft[],
): Draft | undefined {
  return rest.find((draft) =>
    draft.blockers.every((blocker) =>
      order.some((done) => done.number === blocker),
    ),
  );
}

function walked(
  rest: readonly Draft[],
  path: readonly number[],
): readonly number[] {
  const last = rest.find((draft) => draft.number === path.at(-1));
  const blocker = last?.blockers.find((number) =>
    rest.some((draft) => draft.number === number),
  );
  if (blocker === undefined) return path;
  const seen = path.indexOf(blocker);
  return seen === -1
    ? walked(rest, path.concat(blocker))
    : path.slice(seen).concat(blocker);
}

function ordered(order: readonly Draft[], rest: readonly Draft[]): PlanCheck {
  const next = nextDraft(order, rest);
  if (next !== undefined)
    return ordered(
      order.concat(next),
      rest.filter((draft) => draft !== next),
    );
  if (rest.length === 0) return { kind: "plan", order: order };
  return { kind: "cycle", cycle: walked(rest, [Number(rest[0]?.number)]) };
}

export function checkedPlan(text: string): PlanCheck {
  return ordered([], planDrafts(text));
}

export function cycleText(cycle: readonly number[]): string {
  return cycle.map((number) => `draft ${String(number)}`).join(" -> ");
}

export function ticketText(draft: Draft, tickets: readonly Ticket[]): string {
  const range = dependencyRange(draft.lines);
  const numbered = draft.lines.map((line, index) =>
    index < range.start || index >= range.end
      ? line
      : line.replace(/\bdraft\s+([1-9]\d*)\b/gi, (match, number: string) => {
          const ticket = tickets.find(
            (posted) => posted.draft === Number(number),
          );
          return ticket === undefined ? match : `#${String(ticket.number)}`;
        }),
  );
  return `${[`# ${draft.title}`].concat(numbered).join("\n").trimEnd()}\n`;
}
