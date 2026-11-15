import type { ReadyIssue } from "./feed-selection.ts";

export function issuePayload(cursor: number): string {
  return JSON.stringify({
    labels: ["cloving: ready"],
    state: "open",
    limit: 100,
    cursor,
    maximumBodyBytes: 65536,
  });
}

export function mergedReady(
  ready: readonly ReadyIssue[],
  added: readonly ReadyIssue[],
): readonly ReadyIssue[] {
  return Array.from(
    new Map(ready.concat(added).map((issue) => [issue.number, issue])).values(),
  ).slice(0, 100);
}

export function continuedCursor(
  current: number,
  page: { readonly next: number | null; readonly count: number },
): number | null {
  const { next, count } = page;
  if (count >= 100 || next === null) return null;
  if (next <= current) throw new Error("invalid-feed-result");
  if (next >= 1000) throw new Error("issues-limit");
  return next;
}

export function completedFeedText(result: {
  readonly kind: string;
  readonly result?: string | null;
  readonly reason?: string | null;
}): string {
  if (result.kind !== "completed")
    throw new Error(result.reason ?? "github-call-failed");
  if (result.result === null || result.result === undefined)
    throw new Error("github-call-failed");
  return result.result;
}
