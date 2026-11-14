import type { ReadyIssue, BlockerState } from "./feed-selection.ts";

function fields(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("invalid-feed-result");
  return Object.fromEntries(Object.entries(value));
}

function numberOf(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new Error("invalid-feed-result");
  return value;
}

function textOf(value: unknown): string {
  if (typeof value !== "string") throw new Error("invalid-feed-result");
  return value;
}

function rowsOf(text: string): readonly unknown[] {
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value)) throw new Error("invalid-feed-result");
  return value.map((row: unknown) => row);
}

export function readyIssuesOf(text: string): readonly ReadyIssue[] {
  return rowsOf(text).map((row) => {
    const issue = fields(row);
    return {
      number: numberOf(issue["number"]),
      url: textOf(issue["url"]),
      title: textOf(issue["title"]),
      body: textOf(issue["body"]),
      createdAt: textOf(issue["createdAt"]),
    };
  });
}

export function blockerStatesOf(text: string): readonly BlockerState[] {
  return rowsOf(text).map((row) => {
    const issue = fields(row);
    const state = issue["state"];
    if (state !== "open" && state !== "closed" && state !== "missing")
      throw new Error("invalid-feed-result");
    return { number: numberOf(issue["number"]), state };
  });
}
