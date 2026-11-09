import type { Fields, Reply, ServiceRequest } from "../src/protocol.ts";
import type { WatchModel } from "../src/cli/watch-render.ts";
import { floorModel } from "./watch-floor-fixture.ts";
import { watchReplies } from "./watch-service-fixture.ts";

const now = Date.now();

export function minutesFromNow(minutes: number): string {
  return new Date(now + minutes * 60000).toISOString();
}

export const nextReview = now + 120 * 60000;

export const loopSchedules: readonly Fields[] = [
  {
    workflowId: "review-day",
    everySeconds: 1800,
    state: "active",
    failuresInRow: 0,
    nextAt: nextReview,
    stoppedAt: null,
  },
  {
    workflowId: "docs-drift",
    at: "07:00",
    timeZone: "America/Los_Angeles",
    weekdays: ["monday"],
    state: "stopped",
    failuresInRow: 3,
    nextAt: null,
    nextLocal: null,
    stoppedAt: now - 60000,
  },
];

export const loopRuns: readonly Fields[] = [
  {
    runId: "review-old",
    workflowId: "review-day",
    state: "completed",
    latestSequence: 0,
    latestAt: minutesFromNow(-90),
    scheduled: { slot: 3 },
    outcome: { kind: "completed" },
  },
  {
    runId: "review-new",
    workflowId: "review-day",
    state: "completed",
    latestSequence: 0,
    latestAt: minutesFromNow(-30),
    scheduled: { slot: 4 },
    outcome: { kind: "handoff_requested" },
  },
  {
    runId: "review-card",
    workflowId: "review-day",
    state: "running",
    latestSequence: 0,
    latestAt: minutesFromNow(-1),
  },
  {
    runId: "drift-manual",
    workflowId: "docs-drift",
    state: "failed",
    latestSequence: 0,
    latestAt: minutesFromNow(-60 * 24 * 30),
    manualFromLoop: true,
    outcome: null,
  },
];

export const expectedLoops = [
  {
    workflowId: "review-day",
    rule: "every 30 min",
    state: "active",
    nextAt: new Date(nextReview).toISOString(),
    failuresInRow: 0,
    lastRun: {
      runId: "review-new",
      state: "completed",
      outcome: "handoff_requested",
      endedAt: minutesFromNow(-30),
    },
  },
  {
    workflowId: "docs-drift",
    rule: "Mondays at 07:00 America/Los_Angeles",
    state: "stopped",
    nextAt: null,
    failuresInRow: 3,
    lastRun: {
      runId: "drift-manual",
      state: "failed",
      outcome: null,
      endedAt: minutesFromNow(-60 * 24 * 30),
    },
  },
];

export function loopReplies(
  schedules: readonly Fields[] | Fields = loopSchedules,
): ReturnType<typeof watchReplies> {
  const replies = watchReplies({
    workflows: ["review-day", "docs-drift"],
    runs: loopRuns,
  });
  const answer = (request: ServiceRequest): Reply => {
    const reply = replies.answer(request);
    if (
      request.operation !== "status" ||
      request.parameters["runId"] !== undefined ||
      reply.kind !== "result"
    )
      return reply;
    return { kind: "result", result: { ...reply.result, schedules } };
  };
  return { ...replies, answer };
}

export const loopNow = "2026-11-16T13:00:00.000Z";
export const loopNextAt = Date.parse("2026-11-16T15:00:00.000Z");
export const loopEndedAt = "2026-11-16T12:30:00.000Z";

export function loopModel(): WatchModel {
  return floorModel([], {
    schedules: [
      {
        workflowId: "review-day",
        everySeconds: 1800,
        state: "active",
        failuresInRow: 0,
        nextAt: loopNextAt,
        stoppedAt: null,
      },
      {
        workflowId: "docs-drift",
        at: "07:00",
        timeZone: "America/Los_Angeles",
        weekdays: ["monday"],
        nextLocal: null,
        state: "stopped",
        failuresInRow: 3,
        nextAt: null,
        stoppedAt: Date.parse(loopEndedAt),
      },
    ],
    loopRuns: [
      {
        runId: "review-new",
        workflowId: "review-day",
        state: "completed",
        latestAt: loopEndedAt,
        scheduled: { slot: 4 },
        outcome: { kind: "handoff_requested" },
      },
    ],
  });
}
