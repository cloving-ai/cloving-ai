import { ticketStatus, type TicketStatus } from "../ticket-status.ts";
import { sumPrices } from "../worker-usage.ts";
import { changes, type Changes, type WorkTree } from "./work-tree.ts";
import type { StreamResult } from "./claude-turn.ts";

type ReportFields = Changes &
  Pick<
    StreamResult,
    "costUsd" | "usage" | "model" | "attempts" | "sessionId" | "turns"
  > & {
    readonly harness: string;
    readonly ticketStatus: TicketStatus;
    readonly summary: string;
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
  return boundedReport(
    {
      harness: harness.worker,
      ticketStatus: ticketStatus(result.text, result.ticketStatus),
      summary:
        harness.output === "text"
          ? result.text.slice(-limits.summaryCharacters)
          : result.text.slice(0, limits.summaryCharacters),
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
