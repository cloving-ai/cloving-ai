import type { MessageRecord } from "./normalize.ts";

export interface RedactionSettings {
  readonly home: string | null;
  readonly privateTexts: readonly string[];
}

export const replacements = {
  privateKey: "[PRIVATE_KEY]",
  credentialUrl: "[CREDENTIAL_URL]",
  homePath: "[HOME_PATH]",
  token: "[TOKEN]",
  email: "[EMAIL]",
  privateText: "[PRIVATE_TEXT]",
} as const;

export const categories = [
  "privateKey",
  "credentialUrl",
  "homePath",
  "token",
  "email",
  "privateText",
] as const;

export type Category = keyof typeof replacements;
export type RedactionCounts = Record<Category, number>;
interface Span {
  start: number;
  end: number;
  category: Category;
}

export function emptyCounts(): RedactionCounts {
  return {
    privateKey: 0,
    credentialUrl: 0,
    homePath: 0,
    token: 0,
    email: 0,
    privateText: 0,
  };
}

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function patternSpans(
  text: string,
  rule: { readonly pattern: RegExp; readonly category: Category },
): Span[] {
  return [...text.matchAll(rule.pattern)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    category: rule.category,
  }));
}

function homeRoot(home: string | null): string {
  if (home === null || home === "") return "~";
  if (home === "/") return "(?:(?=/)|~)";
  return `(?:${escaped(home.replace(/\/$/, ""))}|~)`;
}

function homeSpans(text: string, home: string | null): Span[] {
  const root = homeRoot(home);
  const pattern = new RegExp(
    String.raw`(?<![\p{L}\p{N}_./~\\-])${root}(?=$|[\s/\x22'\x60<>,;:!?()\[\]{}])(?:/[^\s\x22'\x60<>]*)?`,
    "gu",
  );
  return patternSpans(text, { pattern, category: "homePath" }).map((span) => {
    const quote = text[span.start - 1];
    if (quote !== '"' && quote !== "'" && quote !== "`") return span;
    const end = text.indexOf(quote, span.end);
    return end === -1 ? span : { ...span, end };
  });
}

function spans(text: string, settings: RedactionSettings): Span[] {
  const rules = [
    {
      pattern:
        /-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY)-----[\s\S]*?-----END \1-----/g,
      category: "privateKey",
    },
    {
      pattern: /\b[a-z][a-z\d+.-]*:\/\/[^\s<>"'`/?#]*@[^\s<>"'`]+/gi,
      category: "credentialUrl",
    },
    {
      pattern:
        /(?:gh[pousr]_|github_pat_|sk-ant-|sk-(?:proj-|svcacct-)?)[a-z\d_-]+/gi,
      category: "token",
    },
    {
      pattern: /[\w.!#$%&'*+/=?^`{|}~-]+@[\w.-]+\.[a-z]{2,}/gi,
      category: "email",
    },
  ] as const;
  const matches = rules.flatMap((rule) => patternSpans(text, rule));
  matches.push(...homeSpans(text, settings.home));
  for (const privateText of settings.privateTexts) {
    if (privateText.trim() === "") throw new Error("invalid-settings");
    const pattern = new RegExp(`(?=(${escaped(privateText)}))`, "gi");
    for (const match of text.matchAll(pattern))
      matches.push({
        start: match.index,
        end: match.index + String(match[1]).length,
        category: "privateText",
      });
  }
  return mergeSpans(matches);
}

function mergeSpans(matches: Span[]): Span[] {
  const priority = categories;
  const merged: Span[] = [];
  for (const match of matches.sort((left, right) => left.start - right.start)) {
    const previous = merged.at(-1);
    if (previous === undefined || previous.end <= match.start) {
      merged.push({ ...match });
      continue;
    }
    previous.end = Math.max(previous.end, match.end);
    if (priority.indexOf(match.category) < priority.indexOf(previous.category))
      previous.category = match.category;
  }
  return merged;
}

interface RedactionContext {
  readonly settings: RedactionSettings;
  readonly counts: RedactionCounts;
}

function redactText(text: string, context: RedactionContext): string {
  const { settings, counts } = context;
  let result = "";
  let cursor = 0;
  for (const span of spans(text, settings)) {
    result += text.slice(cursor, span.start) + replacements[span.category];
    cursor = span.end;
    counts[span.category]++;
  }
  return result + text.slice(cursor);
}

function rawJsonApi(
  value: object,
): value is { isRawJSON: (input: unknown) => boolean } {
  return "isRawJSON" in value && typeof value.isRawJSON === "function";
}

function rawJson(value: unknown): boolean {
  return rawJsonApi(JSON) && JSON.isRawJSON(value);
}

function nested(value: unknown, context: RedactionContext): unknown {
  if (typeof value === "string") return redactText(value, context);
  if (rawJson(value)) return value;
  if (Array.isArray(value))
    return value.map((item: unknown) => nested(item, context));
  if (value === null || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const redactedKey = redactText(key, context);
    if (Object.hasOwn(result, redactedKey))
      throw new Error("member-name-collision");
    Object.defineProperty(result, redactedKey, {
      value: nested(item, context),
      enumerable: true,
    });
  }
  return result;
}

export function redactRecord(
  record: MessageRecord,
  settings: RedactionSettings,
) {
  const counts = emptyCounts();
  const context = { settings, counts };
  const blocks = record.blocks.map((block) => {
    if (block["type"] === "tool_use")
      return { ...block, input: nested(block["input"], context) };
    if (block["type"] === "tool_result")
      return { ...block, content: nested(block["content"], context) };
    if (block["type"] === "text" && typeof block["text"] === "string")
      return { ...block, text: redactText(block["text"], context) };
    return block;
  });
  const text = redactText(record.text, context);
  return {
    record: { ...record, text, blocks },
    counts,
    totalCount: Object.values(counts).reduce((sum, count) => sum + count, 0),
  };
}
