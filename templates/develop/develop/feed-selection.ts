export function blockersOf(body: string): readonly number[] {
  const lines = body.split(/\r?\n/);
  const heading = lines.findIndex((line) => /^## Dependencies\s*$/.test(line));
  if (heading === -1) return [];
  const below = lines.slice(heading + 1);
  const next = below.findIndex((line) => /^#{1,2} /.test(line));
  const text = below
    .slice(0, next === -1 ? below.length : next)
    .join("\n")
    .replace(/\b(?:e\.g|i\.e)\./g, "example");
  const needs =
    /(?:^|[.!?]\s+|\n)\s*(?:[-*+]\s+|\d+\.\s+)?Needs\b([\s\S]*?)(?=[.!?](?:\s|$)|$)/g;
  const numbers = Array.from(text.matchAll(needs)).flatMap((sentence) =>
    Array.from(String(sentence[1]).matchAll(/#([1-9]\d*)\b/g)).map((match) =>
      Number(match[1]),
    ),
  );
  return Array.from(new Set(numbers));
}

export interface ReadyIssue {
  readonly number: number;
  readonly url: string;
  readonly title: string;
  readonly body: string;
  readonly createdAt: string;
  readonly bodyOmitted?: "result-too-large" | "body-limit";
}

export interface BlockerState {
  readonly number: number;
  readonly state: "open" | "closed" | "missing";
}

function ticketText(issue: ReadyIssue): string {
  const repository = new URL(issue.url).pathname
    .split("/")
    .slice(1, 3)
    .join("/");
  return `# ${issue.title}\n\nGitHub issue: ${repository}#${String(issue.number)}\n\n${issue.body}`;
}

interface Selection {
  readonly picks: { id: string; text: string }[];
  readonly skipped: { id: string; reason: string }[];
}

function skip(result: Selection, item: { id: string; reason: string }): void {
  if (result.skipped.length < 50) result.skipped.push(item);
}

function addPick(result: Selection, issue: ReadyIssue): void {
  const id = String(issue.number);
  if (issue.bodyOmitted !== undefined) {
    skip(result, {
      id,
      reason:
        issue.bodyOmitted === "body-limit"
          ? "ticket too large"
          : "issue result too large",
    });
    return;
  }
  const text = ticketText(issue);
  if (new TextEncoder().encode(text).length > 65536) {
    skip(result, { id, reason: "ticket too large" });
    return;
  }
  if (result.picks.length < 20) result.picks.push({ id, text });
}

function bounded(result: Selection, ids: readonly string[]): Selection {
  while (new TextEncoder().encode(JSON.stringify(result)).length > 262144) {
    const pick = result.picks.pop();
    if (pick === undefined) throw new Error("invalid-feed-result");
    skip(result, { id: pick.id, reason: "feed result too large" });
  }
  result.skipped.sort(
    (left, right) => ids.indexOf(left.id) - ids.indexOf(right.id),
  );
  return result;
}

export function selected(
  ready: readonly ReadyIssue[],
  context: {
    readonly states: readonly BlockerState[];
    readonly active: readonly string[];
  },
): Selection {
  const { states, active } = context;
  const known = new Map(states.map((item) => [item.number, item.state]));
  const result: Selection = { picks: [], skipped: [] };
  const ordered = ready.toSorted(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.number - right.number,
  );
  for (const issue of ordered) {
    const id = String(issue.number);
    const blockers = blockersOf(issue.body);
    if (
      blockers.some((number) => !Number.isSafeInteger(number)) &&
      !active.includes(id)
    ) {
      skip(result, { id, reason: "invalid blocker number" });
      continue;
    }
    const blocker = blockers.find((number) => known.get(number) !== "closed");
    const waiting =
      blocker === undefined ? undefined : `waits for #${String(blocker)}`;
    const reason = active.includes(id) ? "in work" : waiting;
    if (reason !== undefined) {
      skip(result, { id, reason });
      continue;
    }
    addPick(result, issue);
  }
  return bounded(
    result,
    ordered.map((issue) => String(issue.number)),
  );
}

export function blockerNumbersOf(
  ready: readonly ReadyIssue[],
): readonly number[] {
  return Array.from(
    new Set(
      ready
        .filter((issue) => blockersOf(issue.body).every(Number.isSafeInteger))
        .flatMap((issue) => blockersOf(issue.body)),
    ),
  );
}
