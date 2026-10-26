import { record, type Fields } from "../protocol.ts";
import { priceOf, usageOf } from "../worker-usage.ts";
import type { WatchTurn } from "./watch-render.ts";

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function emptyTurn(operationId: string, runId: string): WatchTurn {
  return {
    operationId,
    runId,
    key: operationId,
    usage: usageOf(null),
    costUsd: null,
    estimatedCostUsd: null,
    target: "",
    branch: "",
    worktree: "",
    startedAt: "",
    endedAt: null,
    activeAt: null,
    outcome: "ended",
    activity: [],
    commits: [],
    files: [],
    uncommitted: [],
    summary: "",
  };
}

export function priceFields(value: unknown): { readonly costUsd?: number } {
  const cost = priceOf(value);
  return cost === null ? {} : { costUsd: cost };
}

export function statusTurns(
  turns: readonly WatchTurn[],
  status: Fields,
): readonly WatchTurn[] {
  const runId = text(status["runId"]);
  const journal = turns.filter((turn) => turn.runId === runId);
  if (!Array.isArray(status["workerTurns"])) return journal;
  const ended = status["workerTurns"].map((value) => {
    const fields = record(value) ?? {};
    const operationId = text(fields["operationId"]);
    const known =
      journal.find((turn) => turn.operationId === operationId) ??
      emptyTurn(operationId, runId);
    return {
      ...known,
      ...(typeof fields["harness"] === "string"
        ? { harness: fields["harness"] }
        : {}),
      runId,
      operationId,
      outcome: known.outcome === "in work" ? "ended" : known.outcome,
      activeAt: null,
      usage: usageOf(fields["usage"]),
      costUsd: priceOf(fields["costUsd"]),
      estimatedCostUsd: priceOf(fields["estimatedCostUsd"]),
      activity: known.activity.map((item) =>
        item.kind === "result"
          ? {
              kind: item.kind,
              text: item.text,
              ...priceFields(fields["costUsd"]),
            }
          : item,
      ),
    };
  });
  return [
    ...ended,
    ...journal.filter(
      (turn) =>
        turn.outcome === "in work" &&
        !ended.some((item) => item.operationId === turn.operationId),
    ),
  ];
}
