import assert from "node:assert/strict";
import type { Fields, Reply, ServiceRequest } from "../src/protocol.ts";
import { fields, items } from "./service-fixture.ts";
import { watchReplies } from "./watch-service-fixture.ts";

export const attentionMark = { text: "Needs attention", laterRunId: null };
export const laterMark = {
  text: "Done in a later run",
  laterRunId: "zz-later",
};

export function completionReplies(
  latestAt: string | null = "2020-01-01T00:00:00Z",
) {
  const recent = new Date().toISOString();
  const runs: Fields[] = [
    {
      runId: "a-stopped",
      ticketId: "DEMO-1",
      workflowId: "develop-issue",
      state: "completed",
      outcome: { kind: "blocked" },
      latestAt: recent,
      latestSequence: 1001,
    },
    ...Array.from({ length: 50 }, (_, index) => ({
      runId: `done-${String(index).padStart(2, "0")}`,
      ticketId: "OTHER",
      workflowId: "develop-issue",
      state: "completed",
      outcome: { kind: "handoff_requested" },
      latestAt: recent,
      latestSequence: 2,
    })),
    {
      runId: "zz-later",
      ticketId: "DEMO-1",
      workflowId: "develop-issue",
      state: "completed",
      outcome: { kind: "handoff_requested" },
      latestAt,
      latestSequence: 1001,
    },
  ];
  const eventsByRun: Record<string, readonly Fields[]> = {
    "a-stopped": pagedEvidence("run.completed", {
      recordedAt: "2026-10-14T10:00:00Z",
      at: 1000,
    }),
    "zz-later": pagedEvidence("run.created", {
      recordedAt: "2026-10-14T10:01:00Z",
      at: 0,
    }),
  };
  const replies = watchReplies({ runs, eventsByRun });
  const answer = (request: ServiceRequest): Reply =>
    summarizedReply(request, replies.answer(request));
  return { ...replies, answer, runs };
}

function summarizedReply(request: ServiceRequest, reply: Reply): Reply {
  if (
    request.operation !== "status" ||
    request.parameters["runId"] !== undefined ||
    reply.kind !== "result"
  )
    return reply;
  return {
    kind: "result",
    result: {
      ...reply.result,
      runs: items(reply.result["runs"]).map((run) => {
        const { runId, workflowId, state, latestAt, latestSequence } =
          fields(run);
        return { runId, workflowId, state, latestAt, latestSequence };
      }),
    },
  };
}

function pagedEvidence(
  type: string,
  evidence: { readonly recordedAt: string; readonly at: number },
): Fields[] {
  return Array.from({ length: 1001 }, (_, index) => ({
    sequence: index + 1,
    recordedAt: evidence.recordedAt,
    type: index === evidence.at ? type : "run.started",
  }));
}

export function stoppedMark(model: Fields): unknown {
  const board = items(model["workflows"])
    .map(fields)
    .find((workflow) => workflow["workflowId"] === "develop-issue");
  const column = items(board?.["columns"])
    .map(fields)
    .find((column) => column["name"] === "Stopped");
  const card = items(column?.["cards"])
    .map(fields)
    .find((card) => card["runId"] === "a-stopped");
  assert.ok(card);
  return card["completionMark"];
}

export function interruptedCompletionReplies(failure: {
  readonly operation: string;
  readonly runId: string | undefined;
  readonly after: string | number | undefined;
}) {
  const replies = completionReplies();
  let pending = true;
  const answer = (request: ServiceRequest): Reply => {
    const reply = replies.answer(request);
    if (
      pending &&
      request.operation === failure.operation &&
      request.parameters["runId"] === failure.runId &&
      request.parameters["after"] === failure.after
    ) {
      pending = false;
      return {
        kind: "error",
        error: { code: "read-failed", detail: "Interrupted search." },
      };
    }
    return reply;
  };
  return { ...replies, answer };
}
