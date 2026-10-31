import { parse } from "yaml";

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function headTrigger(trigger: unknown): unknown {
  if (!isRecord(trigger)) return trigger;
  const types = patterns(trigger["types"]);
  if (types === undefined) return trigger;
  return types.some((type) =>
    ["opened", "synchronize", "reopened"].includes(type),
  )
    ? trigger
    : false;
}

export function pullRequestTrigger(source: string): unknown {
  try {
    const document: unknown = parse(source, { merge: true });
    if (!isRecord(document) || !("on" in document)) return true;
    const events = document["on"];
    if (typeof events === "string") return events === "pull_request";
    if (Array.isArray(events)) return events.includes("pull_request");
    if (isRecord(events))
      return "pull_request" in events
        ? headTrigger(events["pull_request"])
        : false;
    return true;
  } catch {
    return true;
  }
}

interface CharacterToken {
  readonly kind: "character";
  readonly matcher: RegExp;
  readonly optional: boolean;
  readonly repeat: boolean;
}

type PatternToken = CharacterToken | { readonly kind: "directory" };

function patternToken(token: string): PatternToken {
  if (token === "**/") return { kind: "directory" };
  if (token === "*" || token === "**")
    return {
      kind: "character",
      matcher: token === "*" ? /[^/]/ : /[\s\S]/,
      optional: true,
      repeat: true,
    };
  const literal = token.startsWith("\\") ? token.slice(1) : token;
  const source = token.startsWith("[")
    ? token
    : literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return {
    kind: "character",
    matcher: new RegExp(`^${source}$`),
    optional: false,
    repeat: false,
  };
}

function patternTokens(source: string): readonly PatternToken[] {
  const tokens: PatternToken[] = [];
  for (const raw of source.match(
    /\*\*\/|\*\*|\*|\[[a-zA-Z0-9-]+\]|\\[\s\S]|[\s\S]/g,
  ) ?? []) {
    if (raw !== "?" && raw !== "+") {
      tokens.push(patternToken(raw));
      continue;
    }
    const previous = tokens.pop();
    if (previous?.kind !== "character" || previous.optional || previous.repeat)
      throw new Error("invalid-workflow-filter");
    tokens.push({ ...previous, optional: raw === "?", repeat: raw === "+" });
  }
  return tokens;
}

interface PatternState {
  readonly value: string;
  readonly previous: readonly boolean[];
}

function advanceDirectory({
  value,
  previous,
}: PatternState): readonly boolean[] {
  let reachable = false;
  return Array.from({ length: value.length + 1 }, (_, index) => {
    const matches =
      previous[index] === true || (reachable && value[index - 1] === "/");
    reachable ||= previous[index] === true;
    return matches;
  });
}

function advancePattern(
  token: CharacterToken,
  input: PatternState,
): readonly boolean[] {
  const { value, previous } = input;
  const next: boolean[] = [];
  for (let index = 0; index <= value.length; index += 1) {
    const consumes = index > 0 && token.matcher.test(value[index - 1] ?? "");
    next[index] =
      (token.optional && previous[index] === true) ||
      (consumes &&
        (previous[index - 1] === true ||
          (token.repeat && next[index - 1] === true)));
  }
  return next;
}

function matchesPattern(value: string, source: string): boolean {
  let previous: readonly boolean[] = [true];
  for (const token of patternTokens(source))
    previous =
      token.kind === "directory"
        ? advanceDirectory({ value, previous })
        : advancePattern(token, { value, previous });
  return previous[value.length] === true;
}

function selected(
  value: string,
  patterns: readonly string[],
): boolean | undefined {
  let included = false;
  for (const pattern of patterns) {
    const negative = pattern.startsWith("!");
    const source = negative ? pattern.slice(1) : pattern;
    try {
      if (matchesPattern(value, source)) included = !negative;
    } catch {
      return undefined;
    }
  }
  return included;
}

function patterns(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return value.every(
    (item: unknown): item is string => typeof item === "string",
  )
    ? value
    : undefined;
}

function allows(
  values: readonly string[],
  filters: { readonly include: unknown; readonly ignore: unknown },
): boolean {
  const include = patterns(filters.include);
  const ignore = patterns(filters.ignore);
  if (
    include !== undefined &&
    !values.some((value) => selected(value, include) !== false)
  )
    return false;
  return (
    ignore === undefined ||
    values.some((value) => selected(value, ignore) !== true)
  );
}

export function workflowApplies(
  trigger: unknown,
  context: { readonly branch: string; readonly paths: readonly string[] },
): boolean {
  if (!isRecord(trigger)) return trigger !== false;
  return (
    allows([context.branch], {
      include: trigger["branches"],
      ignore: trigger["branches-ignore"],
    }) &&
    allows(context.paths, {
      include: trigger["paths"],
      ignore: trigger["paths-ignore"],
    })
  );
}
