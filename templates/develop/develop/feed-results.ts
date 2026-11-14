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
    return Object.assign(
      {
        number: numberOf(issue["number"]),
        url: textOf(issue["url"]),
        title: textOf(issue["title"]),
        body: bodyOf(issue),
        createdAt: textOf(issue["createdAt"]),
      },
      omittedBodyOf(issue["bodyOmitted"]),
    );
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

function omittedBodyOf(value: unknown): {
  readonly bodyOmitted?: "result-too-large" | "body-limit";
} {
  if (value === undefined) return {};
  if (value !== "result-too-large" && value !== "body-limit")
    throw new Error("invalid-feed-result");
  return { bodyOmitted: value };
}

export function readyIssuePageOf(text: string) {
  const page = fields(JSON.parse(text));
  const cursor = page["cursor"];
  if (
    cursor !== null &&
    (typeof cursor !== "number" ||
      !Number.isSafeInteger(cursor) ||
      cursor < 1 ||
      cursor > 1000)
  )
    throw new Error("invalid-feed-result");
  return { issues: readyIssuesOf(JSON.stringify(page["issues"])), cursor };
}

function bodyOf(issue: Readonly<Record<string, unknown>>): string {
  const body = textOf(issue["body"]);
  if (issue["bodyEncoding"] === undefined) return body;
  if (issue["bodyEncoding"] !== "base64")
    throw new Error("invalid-feed-result");
  const decoded = atob(body);
  if (btoa(decoded) !== body) throw new Error("invalid-feed-result");
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    Uint8Array.from(decoded, (character) => character.charCodeAt(0)),
  );
}
