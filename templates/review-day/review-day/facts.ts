import type { ProtectedResult } from "cloving/workflows";
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

function commandJson(result: ProtectedResult): unknown {
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

export async function reviewFacts() {
  const input: Readonly<Record<string, never>> = {};
  const report = fields(
    commandJson(
      await runCommand({
        scope: { phase: "review-day", operation: "report", round: 1 },
        name: "report",
        input: input,
      }),
    ),
  );
  const reviews = issues(
    commandJson(
      await runCommand({
        scope: { phase: "review-day", operation: "reviews", round: 1 },
        name: "reviews",
        input: input,
      }),
    ),
  );
  const improvements = issues(
    commandJson(
      await runCommand({
        scope: { phase: "review-day", operation: "improvements", round: 1 },
        name: "improvements",
        input: input,
      }),
    ),
  );
  return { report, reviews, improvements };
}

export type ReviewFacts = Awaited<ReturnType<typeof reviewFacts>>;
