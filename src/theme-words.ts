import { record } from "./protocol.ts";

export const themeWords: Readonly<Record<string, "text" | "plural">> = {
  "workflows.title": "text",
  "column.done": "text",
  "column.stopped": "text",
  "state.attention": "text",
  "state.decision": "text",
  "station.agent": "text",
  "station.review": "text",
  "totals.label": "text",
  "today.title": "text",
  "needs.title": "text",
  "ready.count": "plural",
  "completed.unit": "plural",
  "run.unit": "plural",
  "ticket.unit": "plural",
};

const notPlain = /[\p{Cc}\p{Zl}\p{Zp}<>{}]/u;

function fits(text: string): boolean {
  const length = Array.from(text).length;
  return length >= 1 && length <= 60;
}

export function isPlainText(value: unknown): value is string {
  return typeof value === "string" && fits(value) && !notPlain.test(value);
}

function isPluralForm(value: unknown): boolean {
  return (
    typeof value === "string" &&
    fits(value) &&
    !notPlain.test(value.replaceAll("{count}", ""))
  );
}

function isPlural(value: unknown): boolean {
  const forms = record(value);
  return (
    forms !== undefined &&
    Object.keys(forms).sort().join(" ") === "one other" &&
    isPluralForm(forms["one"]) &&
    isPluralForm(forms["other"])
  );
}

export function wordCodes(value: unknown): readonly string[] {
  if (value === undefined) return [];
  const words = record(value);
  if (words === undefined) return ["invalid-word"];
  return Object.entries(words).flatMap(([key, word]) => {
    const kind = Object.hasOwn(themeWords, key) ? themeWords[key] : undefined;
    if (kind === undefined) return ["unknown-word"];
    const valid = kind === "text" ? isPlainText(word) : isPlural(word);
    return valid ? [] : ["invalid-word"];
  });
}
