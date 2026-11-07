import type { ProtectedResult } from "cloving/workflows";
import { runCommand } from "cloving/workflows/steps/run-command";

export interface PatrolInput {
  readonly cycleId: string;
  readonly input: Readonly<Record<string, never>>;
}

export interface StuckPull {
  readonly number: number;
  readonly branch: string;
  readonly state: string;
  readonly reason: string;
  readonly head: string;
  readonly score: number | null;
  readonly issue: string | null;
  readonly ticketStatus: string | null;
}

function statusText(result: ProtectedResult): string {
  if (result.kind !== "completed")
    throw new Error(result.reason ?? result.kind);
  return result.result ?? "null";
}

function invalid(): never {
  throw new Error("invalid-patrol-status");
}

function fields(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    invalid();
  return Object.fromEntries(Object.entries(value));
}

function listed(text: string): readonly Record<string, unknown>[] {
  let value: unknown = null;
  try {
    value = JSON.parse(text);
  } catch {
    invalid();
  }
  if (!Array.isArray(value)) invalid();
  return value.map((item: unknown) => fields(item));
}

function checked(pull: Record<string, unknown>): Record<string, unknown> {
  const { number, branch, state, active } = pull;
  if (
    typeof number !== "number" ||
    !Number.isSafeInteger(number) ||
    number < 1 ||
    typeof branch !== "string" ||
    typeof state !== "string" ||
    typeof active !== "boolean"
  )
    invalid();
  return pull;
}

function idle(pull: Record<string, unknown>): boolean {
  return (
    pull["active"] === false && String(pull["branch"]).startsWith("cloving/")
  );
}

function candidate(pull: Record<string, unknown>): boolean {
  return idle(pull) && ["blocked", "failed"].includes(String(pull["state"]));
}

function optional(value: unknown, pattern: RegExp): string | null {
  if (value === undefined || value === null) return null;
  return typeof value === "string" && pattern.test(value) ? value : invalid();
}

function score(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 5
    ? value
    : invalid();
}

function stuckPull(pull: Record<string, unknown>): StuckPull {
  const { reason, head } = pull;
  if (
    typeof reason !== "string" ||
    reason.trim() === "" ||
    typeof head !== "string" ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head)
  )
    invalid();
  return {
    number: Number(pull["number"]),
    branch: String(pull["branch"]),
    state: String(pull["state"]),
    reason: reason.trim(),
    head,
    score: score(pull["score"]),
    issue: optional(pull["issue"], /^[\w.-]+\/[\w.-]+#[1-9]\d*$/),
    ticketStatus: optional(pull["ticketStatus"], /^(?:complete|partial)$/),
  };
}

export interface PatrolStatus {
  readonly stuck: readonly StuckPull[];
  readonly open: readonly number[];
}

export async function patrolStatus(): Promise<PatrolStatus> {
  const input: Readonly<Record<string, never>> = {};
  const text = statusText(
    await runCommand({
      scope: { phase: "patrol", operation: "patrol-status", round: 1 },
      name: "patrol-status",
      input: input,
    }),
  );
  const pulls = listed(text).map((pull) => checked(pull));
  return {
    stuck: pulls
      .filter((pull) => candidate(pull))
      .map((pull) => stuckPull(pull)),
    open: pulls
      .filter((pull) => idle(pull) && !candidate(pull))
      .map((pull) => Number(pull["number"])),
  };
}
