import type { ReviewFacts } from "./facts.ts";
import { count, list, record, text } from "./input.ts";

export type CheckKind = "enable-rule" | "new-rule" | "quality-check";

export interface Suggestion {
  readonly name: string;
  readonly shape: string;
  readonly links: readonly string[];
  readonly kind: CheckKind;
  readonly rule: string;
  readonly hits: number;
  readonly countCommand: string;
  readonly scope: "all" | "changed";
}

const bad = "invalid-check-suggestions";
const plain = /^(?!.*@[\w.-]+(?![\w.-]|\/))[^\n]*\S/;

function kindOf(value: unknown): CheckKind {
  if (
    value === "enable-rule" ||
    value === "new-rule" ||
    value === "quality-check"
  )
    return value;
  throw new Error(bad);
}

function scopeOf(value: unknown): "all" | "changed" {
  if (value === "all" || value === "changed") return value;
  throw new Error(bad);
}

function suggestionOf(value: unknown): Suggestion {
  const item = record(value, bad);
  return {
    name: text(item["name"], {
      reason: bad,
      pattern: /^[a-z][a-z0-9-]{0,63}$/,
      maximum: 64,
    }),
    shape: text(item["shape"], { reason: bad, pattern: plain, maximum: 600 }),
    links: list(item["links"], { reason: bad, maximum: 20 }).map((link) =>
      text(link, { reason: bad, pattern: /^https:\/\/\S+$/, maximum: 300 }),
    ),
    kind: kindOf(item["kind"]),
    rule: text(item["rule"], {
      reason: bad,
      pattern: /^(?:@[\w.-]+\/)?[\w.-]+(?:\/[\w.-]+)?$/,
      maximum: 100,
    }),
    hits: count(item["hits"], bad),
    countCommand: text(item["countCommand"], {
      reason: bad,
      pattern: plain,
      maximum: 300,
    }),
    scope: scopeOf(item["scope"]),
  };
}

export function suggestionsOf(result: unknown): readonly Suggestion[] {
  const summary = record(result, bad)["summary"];
  if (typeof summary !== "string") throw new Error(bad);
  if (summary.length > 12000) throw new Error("check-suggestions-too-large");
  let value: unknown;
  try {
    value = JSON.parse(summary);
  } catch {
    throw new Error(bad);
  }
  return list(record(value, bad)["suggestions"], {
    reason: bad,
    maximum: 5,
  }).map((item) => suggestionOf(item));
}

function grouped(
  suggestion: Suggestion,
  facts: ReviewFacts,
): readonly string[] {
  const links = facts.comments
    .filter((comment) => suggestion.links.includes(comment.url))
    .map((comment) => comment.url);
  const pulls = new Set(
    facts.comments
      .filter((comment) => links.includes(comment.url))
      .map((comment) => comment.pullRequest),
  );
  const distinct = Array.from(new Set(links));
  return distinct.length >= 3 && pulls.size >= 2 ? distinct : [];
}

function reported(suggestion: Suggestion, facts: ReviewFacts): boolean {
  return (
    facts.qualityChecks.includes(suggestion.rule) ||
    Object.entries(facts.lintRules).some(
      ([name, level]) => name === suggestion.rule && level !== "off",
    ) ||
    facts.openTickets.some((ticket) => ticket.check === suggestion.name)
  );
}

function decided(suggestion: Suggestion, facts: ReviewFacts): boolean {
  const earlier = facts.decisions.filter(
    (decision) => decision.name === suggestion.name,
  );
  if (earlier.some((decision) => decision.decision === "reject")) return true;
  const seen = earlier.flatMap((decision) => decision.links);
  return (
    earlier.length > 0 && suggestion.links.every((link) => seen.includes(link))
  );
}

export function keptSuggestions(
  suggestions: readonly Suggestion[],
  facts: ReviewFacts,
): readonly Suggestion[] {
  const names = new Set<string>();
  return suggestions.flatMap((suggestion) => {
    const links = grouped(suggestion, facts);
    const known = Object.assign({}, suggestion, { links: links });
    if (links.length === 0 || names.has(suggestion.name)) return [];
    if (reported(known, facts) || decided(known, facts)) return [];
    names.add(suggestion.name);
    return [known];
  });
}
