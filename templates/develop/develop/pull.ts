import type { CycleOutcome, PullRequest } from "cloving/workflows";
import { protectedEffect } from "cloving/workflows/steps/protected-effect";
import type { DevelopTask, DevelopReport } from "./report.ts";
import { queuePartial } from "./queue-partial.ts";

export async function preparePull(cycleId: string): Promise<void> {
  const result = await protectedEffect({
    scope: { phase: "pull-request", operation: "github-prepare", round: 1 },
    capability: "github",
    method: "prepare",
    target: cycleId,
    payload: "{}",
    units: 1,
  });
  if (result.kind !== "completed")
    throw new Error(result.reason ?? result.kind);
}

export async function openPull(request: {
  readonly input: DevelopTask;
  readonly round: number;
}): Promise<PullRequest> {
  const { input, round } = request;
  const result = await protectedEffect({
    scope: { phase: "pull-request", operation: "github-open-pr", round: round },
    capability: "github",
    method: "open-pr",
    target: input.cycleId,
    payload: JSON.stringify({
      title: (input.ticket.split("\n")[0] ?? "Develop task")
        .replace(/^#+\s*/, "")
        .slice(0, 200),
      body: "Review the committed changes and repository checks for this task.",
    }),
    units: 1,
  });
  if (result.kind !== "completed")
    throw new Error(result.reason ?? result.kind);
  const value: unknown = JSON.parse(result.result ?? "null");
  return pullOf(value, input.cycleId);
}

function pullFields(
  value: unknown,
): value is { number: unknown; url: unknown; commit: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    "number" in value &&
    "url" in value &&
    "commit" in value
  );
}

function pullOf(value: unknown, target: string): PullRequest {
  if (!pullFields(value)) throw new Error("invalid-pull-request");
  const { number, url, commit } = value;
  if (
    typeof number !== "number" ||
    !Number.isSafeInteger(number) ||
    number < 1 ||
    typeof url !== "string" ||
    typeof commit !== "string" ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)
  )
    throw new Error("invalid-pull-request");
  return { number, url, commit, target };
}

export async function finishPull(request: {
  readonly input: DevelopTask;
  readonly round: number;
  readonly report: DevelopReport;
  readonly pull: PullRequest;
}): Promise<CycleOutcome> {
  const { input, round, report, pull } = request;
  const outcome = {
    kind: "handoff_requested" as const,
    cycleId: input.cycleId,
    promotionId: `pull-request-${String(pull.number)}`,
    ticketStatus: report.status.kind,
  };
  const target = input.issue;
  if (target === null) return outcome;
  const result =
    report.status.kind === "partial"
      ? await queuePartial({
          cycleId: input.cycleId,
          round,
          issue: target,
          pullRequest: pull.number,
          remaining: report.status.remaining,
        })
      : await protectedEffect({
          scope: {
            phase: "pull-request",
            operation: "github-close-issue",
            round: round,
          },
          capability: "github",
          method: "close-issue",
          target: input.cycleId,
          payload: JSON.stringify({
            owner: target.owner,
            repository: target.repository,
            number: target.number,
            pullRequest: pull.number,
          }),
          units: 1,
        });
  if (result.kind === "completed") return outcome;
  return {
    kind: outcome.kind,
    cycleId: outcome.cycleId,
    promotionId: outcome.promotionId,
    ticketStatus: outcome.ticketStatus,
    issueUpdate: "failed",
  };
}

export async function labelTicket(
  input: DevelopTask,
  state: { readonly key: "start" | "blocked"; readonly round: number },
): Promise<void> {
  const issue = input.issue;
  if (issue === null) return;
  const result = await protectedEffect({
    scope: {
      phase: "pull-request",
      operation: "github-label",
      round: state.round,
      key: state.key,
    },
    capability: "github",
    method: "label",
    target: input.cycleId,
    payload: JSON.stringify({
      owner: issue.owner,
      repository: issue.repository,
      number: issue.number,
      add:
        state.key === "start" ? ["cloving: in progress"] : ["cloving: blocked"],
      remove:
        state.key === "start"
          ? ["cloving: ready", "cloving: blocked"]
          : ["cloving: in progress"],
    }),
    units: 1,
  });
  if (result.kind !== "completed")
    throw new Error(result.reason ?? result.kind);
}
