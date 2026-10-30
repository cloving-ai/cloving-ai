import type { Recorded } from "./operation-journal.ts";
import { ticketStatus, type TicketStatus } from "../ticket-status.ts";
import { reviewReport, type ReviewVerdict } from "../review-subject.ts";
import { sumPrices } from "../worker-usage.ts";
import { changes, type Changes, type WorkTree } from "./work-tree.ts";
import { succeeded, type StreamResult, type TurnEnd } from "./claude-turn.ts";

type ReportFields = Changes &
  Pick<
    StreamResult,
    "costUsd" | "usage" | "model" | "attempts" | "sessionId" | "turns"
  > & {
    readonly harness: string;
    readonly ticketStatus: TicketStatus;
    readonly summary: string;
    readonly reviewVerdict: ReviewVerdict | null;
    readonly worktree: string;
    readonly estimatedCostUsd: number | null;
  };

interface ReportLimits {
  readonly summaryCharacters: number;
  readonly resultBytes: number;
}

function tailReport(fields: ReportFields, limit: number): string | undefined {
  let text = JSON.stringify({ ...fields, summary: "" });
  if (Buffer.byteLength(text) > limit) return undefined;
  let minimum = 1;
  let maximum = fields.summary.length;
  while (minimum <= maximum) {
    const kept = Math.floor((minimum + maximum) / 2);
    const candidate = JSON.stringify({
      ...fields,
      summary: fields.summary.slice(-kept),
    });
    if (Buffer.byteLength(candidate) > limit) {
      maximum = kept - 1;
      continue;
    }
    text = candidate;
    minimum = kept + 1;
  }
  return text;
}

function boundedReport(
  fields: ReportFields,
  options: { readonly output?: "text"; readonly limit: number },
): { readonly text?: string; readonly reason?: string } {
  const text = JSON.stringify(fields);
  const excess = Buffer.byteLength(text) - options.limit;
  if (excess <= 0) return { text };
  if (options.output === "text") {
    const shortened = tailReport(fields, options.limit);
    return shortened === undefined
      ? { reason: "claude-result-too-large" }
      : { text: shortened };
  }
  const kept = Math.max(0, fields.summary.length - excess);
  const shortened = JSON.stringify({
    ...fields,
    summary: fields.summary.slice(0, kept),
  });
  if (Buffer.byteLength(shortened) <= options.limit) return { text: shortened };
  const metadata = JSON.stringify({
    ...fields,
    ticketStatus: undefined,
    summary: "",
  });
  return {
    reason: "claude-result-too-large",
    ...(Buffer.byteLength(metadata) <= options.limit ? { text: metadata } : {}),
  };
}

export async function turnReport(
  start: {
    readonly harness: { readonly worker: string; readonly output?: "text" };
    readonly tree: WorkTree;
    readonly limits: ReportLimits;
  },
  result: StreamResult,
): Promise<{ readonly text?: string; readonly reason?: string }> {
  if (result.ticketStatusTooLarge === true)
    return { reason: "claude-result-too-large" };
  const { harness, tree, limits } = start;
  const review = reviewReport(result.text);
  const feedback = result.reviewFeedback ?? review.feedback;
  return boundedReport(
    {
      harness: harness.worker,
      ticketStatus: ticketStatus(result.text, result.ticketStatus),
      reviewVerdict:
        result.reviewVerdict === undefined
          ? review.reviewVerdict
          : result.reviewVerdict,
      summary:
        harness.output === "text"
          ? feedback.slice(-limits.summaryCharacters)
          : feedback.slice(0, limits.summaryCharacters),
      ...(await changes(tree)),
      worktree: tree.path,
      costUsd: result.costUsd,
      usage: result.usage,
      model: result.model,
      ...(result.attempts === undefined ? {} : { attempts: result.attempts }),
      estimatedCostUsd: sumPrices(
        (result.attempts ?? []).map((attempt) => attempt.estimatedCostUsd),
      ),
      sessionId: result.sessionId,
      turns: result.turns,
    },
    { ...harness, limit: limits.resultBytes },
  );
}

export async function turnOutcome(
  running: Parameters<typeof turnReport>[0] & {
    readonly stopping: {
      readonly requested: boolean;
      readonly stoppedBy?: "daemon-shutdown";
    };
  },
  end: TurnEnd,
): Promise<Recorded> {
  const endedAt = new Date().toISOString();
  if (end.stopped === true && running.stopping.stoppedBy === "daemon-shutdown")
    return stoppedOutcome(running.stopping, endedAt);
  const { result } = end;
  const report =
    result === undefined
      ? {}
      : await turnReport(
          {
            tree: running.tree,
            harness: running.harness,
            limits: running.limits,
          },
          result,
        );
  const { text, reason } = report;
  if (succeeded(end) && reason === undefined && text !== undefined)
    return { outcome: "completed", result: text, endedAt };
  if (running.stopping.requested)
    return stoppedOutcome(running.stopping, endedAt);
  return failedOutcome(end, { ...report, endedAt });
}

function failedOutcome(
  end: TurnEnd,
  report: {
    readonly text?: string;
    readonly reason?: string;
    readonly endedAt: string;
  },
): Recorded {
  const { text, reason, endedAt } = report;
  return {
    outcome: "failed",
    reason: end.reason ?? reason ?? "claude-turn-failed",
    ...(end.detail === undefined ? {} : { detail: end.detail }),
    ...(text === undefined ? {} : { result: text }),
    endedAt,
  };
}

function stoppedOutcome(
  stopping: { readonly stoppedBy?: "daemon-shutdown" },
  endedAt: string,
): Recorded {
  return {
    outcome: "stopped",
    endedAt,
    ...(stopping.stoppedBy === undefined
      ? {}
      : { stoppedBy: stopping.stoppedBy }),
  };
}
