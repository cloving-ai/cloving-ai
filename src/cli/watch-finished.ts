import type { PrIdentity, PrObservation } from "./watch-pr-identity.ts";
import type {
  WatchFinished,
  WatchModel,
  WatchPullRequest,
  WatchRun,
} from "./watch-render.ts";

export type IssueState = "open" | "closed" | "unknown";

export interface FinishedChecks {
  readonly issue: (issue: PrIdentity) => IssueState;
  readonly pullRequest: (pullRequest: WatchPullRequest) => PrObservation | null;
  readonly retentionDays: number | null;
}

interface FinishedContext {
  readonly runs: readonly WatchRun[];
  readonly checks: FinishedChecks;
  readonly now: string;
}

const dayMilliseconds = 86_400_000;

function stoppedWork(run: WatchRun): boolean {
  if (run.continuedBy !== undefined) return false;
  if (run.state === "failed") return true;
  return run.state === "completed" && run.outcome === "blocked";
}

function createdAt(run: WatchRun): string {
  return run.events[0]?.recordedAt ?? "";
}

function completedTicket(run: WatchRun): boolean {
  return (
    run.state === "completed" &&
    run.outcome === "handoff_requested" &&
    run.ticketStatus !== "partial" &&
    run.issueUpdate !== "failed"
  );
}

function laterCompleted(run: WatchRun, runs: readonly WatchRun[]): boolean {
  if (run.ticketId === null) return false;
  return runs.some(
    (later) =>
      later.ticketId === run.ticketId &&
      completedTicket(later) &&
      createdAt(later) > createdAt(run),
  );
}

function expired(run: WatchRun, context: FinishedContext): boolean {
  const days = context.checks.retentionDays;
  if (days === null) return false;
  const age = Date.parse(context.now) - Date.parse(run.latestAt ?? "");
  return age > days * dayMilliseconds;
}

function merged(run: WatchRun, checks: FinishedChecks): boolean {
  if (run.mergeProof != null) return true;
  if (run.pullRequest === null) return false;
  const observed = checks.pullRequest(run.pullRequest);
  return (
    observed?.status === "merged" || observed?.lastSuccess?.status === "merged"
  );
}

export function finishedOf(
  run: WatchRun,
  context: FinishedContext,
): WatchFinished | null {
  if (!stoppedWork(run)) return null;
  if (run.events.some((event) => event.type === "run.dismissed"))
    return "dismissed";
  if (laterCompleted(run, context.runs)) return "later-run-completed";
  if (expired(run, context)) return "retention-expired";
  if (
    run.issueIdentity != null &&
    context.checks.issue(run.issueIdentity) === "closed"
  )
    return "ticket-closed";
  return merged(run, context.checks) ? "pull-request-merged" : null;
}

export function finishedModel(
  model: WatchModel,
  checks: FinishedChecks,
): WatchModel {
  const context = { runs: model.runs, checks, now: model.updatedAt };
  return {
    ...model,
    runs: model.runs.map((run) => {
      const finished = finishedOf(run, context);
      return finished === null ? run : { ...run, finished };
    }),
  };
}
