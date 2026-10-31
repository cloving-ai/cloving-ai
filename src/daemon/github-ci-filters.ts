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

function patternToken(token: string): string {
  if (token === "**/") return "(?:.*/)?";
  if (token === "**") return ".*";
  if (token === "*") return "[^/]*";
  if (token === "?" || token === "+" || token.startsWith("[")) return token;
  const literal = token.startsWith("\\") ? token.slice(1) : token;
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function selected(
  value: string,
  patterns: readonly string[],
): boolean | undefined {
  let included = false;
  for (const pattern of patterns) {
    const negative = pattern.startsWith("!");
    const source = negative ? pattern.slice(1) : pattern;
    const tokens =
      source.match(/\*\*\/|\*\*|\*|\[[a-zA-Z0-9-]+\]|\\.|./g) ?? [];
    try {
      if (new RegExp(`^${tokens.map(patternToken).join("")}$`).test(value))
        included = !negative;
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
