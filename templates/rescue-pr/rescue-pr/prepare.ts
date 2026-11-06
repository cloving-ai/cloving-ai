import type { ProtectedResult } from "cloving/workflows";
import { protectedEffect } from "cloving/workflows/steps/protected-effect";
import type { RescueTask } from "./input.ts";

export interface RescueTree {
  readonly target: string;
  readonly base: string;
}

export function resultValue(result: ProtectedResult): Record<string, unknown> {
  if (result.kind !== "completed")
    throw new Error(result.reason ?? result.kind);
  const value: unknown = JSON.parse(result.result ?? "null");
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("invalid-rescue-result");
  return Object.fromEntries(Object.entries(value));
}

export async function prepareRescue(task: RescueTask): Promise<RescueTree> {
  const value = resultValue(
    await protectedEffect({
      scope: { phase: "rescue", operation: "github-prepare", round: 1 },
      capability: "github",
      method: "prepare",
      target: task.cycleId,
      payload: JSON.stringify({ pullRequest: task.pullRequest }),
      units: 1,
    }),
  );
  const { target, base } = value;
  if (
    typeof target !== "string" ||
    !/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(target) ||
    typeof base !== "string" ||
    base.trim() === ""
  )
    throw new Error("invalid-rescue-result");
  return { target, base };
}
