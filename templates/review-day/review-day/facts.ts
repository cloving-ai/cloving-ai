import type { ProtectedResult } from "cloving/workflows";
import { protectedEffect } from "cloving/workflows/steps/protected-effect";
import { runCommand } from "cloving/workflows/steps/run-command";

export interface ReviewInput {
  readonly cycleId: string;
  readonly input: Readonly<Record<string, never>>;
}

export function effectText(result: ProtectedResult): string {
  if (result.kind !== "completed")
    throw new Error(result.reason ?? result.kind);
  if (result.result === null) throw new Error("missing-review-result");
  return result.result;
}

export function fields(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("invalid-review-facts");
  return Object.fromEntries(Object.entries(value));
}

function effectJson(result: ProtectedResult): unknown {
  const text = effectText(result);
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    throw new Error("invalid-review-facts");
  }
}

function issues(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("invalid-review-facts");
  return value.map((issue: unknown) => fields(issue));
}

function improvement(issue: Record<string, unknown>): Record<string, unknown> {
  const body = typeof issue["body"] === "string" ? issue["body"] : "";
  const line = /^Loop:[ \t]*(\S.*)$/m.exec(body);
  return Object.assign({}, issue, { loop: line?.[1]?.trim() ?? null });
}

export async function readIssues(
  input: ReviewInput,
  read: {
    readonly operation: "reviews" | "improvements";
    readonly label: string;
    readonly state: "all" | "open";
    readonly limit: number;
  },
) {
  return issues(
    effectJson(
      await protectedEffect({
        capability: "github",
        method: "issues",
        target: input.cycleId,
        units: 1,
        scope: { phase: "review-day", operation: read.operation, round: 1 },
        payload: JSON.stringify({
          labels: [read.label],
          state: read.state,
          limit: read.limit,
        }),
      }),
    ),
  );
}

export async function reviewFacts(input: ReviewInput) {
  const empty: Readonly<Record<string, never>> = {};
  const report = fields(
    effectJson(
      await runCommand({
        scope: { phase: "review-day", operation: "report", round: 1 },
        name: "report",
        input: empty,
      }),
    ),
  );
  const reviews = await readIssues(input, {
    operation: "reviews",
    label: "cloving: review",
    state: "all",
    limit: 7,
  });
  const open = await readIssues(input, {
    operation: "improvements",
    label: "cloving: improvement",
    state: "open",
    limit: 100,
  });
  if (open.length >= 100) throw new Error("too-many-improvements");
  return { report, reviews, improvements: open.map(improvement) };
}

export type ReviewFacts = Awaited<ReturnType<typeof reviewFacts>>;
