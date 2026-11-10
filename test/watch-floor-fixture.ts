import type { WatchInputs } from "../src/cli/watch-model.ts";
import {
  boardEvent,
  boardModel,
  boardRun,
  boardTime,
  pullStages,
  sampleStages,
} from "./watch-board-fixture.ts";

export function minutesBefore(minutes: number): string {
  return new Date(Date.parse(boardTime) - minutes * 60000).toISOString();
}

function pausedEvent(minutes: number): Record<string, unknown> {
  const at = minutesBefore(minutes);
  return { sequence: Date.parse(at), recordedAt: at, type: "run.paused" };
}

interface FloorRunOptions {
  readonly workflowId?: string;
  readonly state?: string;
  readonly operation?: string;
  readonly minutes?: number;
  readonly ticketId?: string;
  readonly issueIdentity?: unknown;
  readonly harness?: string;
  readonly awaitedRunId?: string;
  readonly commandWaits?: readonly unknown[];
  readonly reason?: { readonly code: string; readonly detail: string };
  readonly pausedMinutes?: number;
}

function floorEvents(options: FloorRunOptions): readonly unknown[] {
  return [
    ...(options.operation === undefined
      ? []
      : [
          boardEvent(options.operation, {
            at: minutesBefore(options.minutes ?? 0),
          }),
        ]),
    ...(options.pausedMinutes === undefined
      ? []
      : [pausedEvent(options.pausedMinutes)]),
  ];
}

export function floorRun(
  runId: string,
  options: FloorRunOptions,
): Record<string, unknown> {
  const run = boardRun(runId, {
    state: options.state ?? "running",
    ...(options.workflowId === undefined
      ? {}
      : { workflowId: options.workflowId }),
    ...(options.ticketId === undefined ? {} : { ticketId: options.ticketId }),
    issueIdentity: options.issueIdentity,
    events: floorEvents(options),
  });
  const status = run["status"];
  return {
    ...run,
    status: {
      ...(typeof status === "object" ? status : {}),
      ...(options.reason === undefined ? {} : { reason: options.reason }),
      ...(options.harness === undefined
        ? {}
        : {
            workerTurns: [{ operationId: "turn-1", harness: options.harness }],
          }),
      ...(options.awaitedRunId === undefined
        ? {}
        : { awaitedRunId: options.awaitedRunId }),
      ...(options.commandWaits === undefined
        ? {}
        : { commandWaits: options.commandWaits }),
    },
  };
}

export function floorModel(
  runs: readonly unknown[],
  changes: Partial<WatchInputs> = {},
) {
  return boardModel(runs, {
    workflows: ["develop-issue", "idea"],
    workflowStages: { "develop-issue": pullStages, idea: sampleStages },
    ...changes,
  });
}

export function twoLineModel() {
  return floorModel([
    floorRun("pr-583", {
      operation: "github-open-pr",
      minutes: 38,
      ticketId: "583",
      harness: "claude",
    }),
    floorRun("turn-585", {
      operation: "claude-turn",
      minutes: 3,
      ticketId: "585",
      harness: "claude",
    }),
    floorRun("draft-run", {
      workflowId: "idea",
      operation: "write-draft",
      minutes: 12,
      harness: "codex",
    }),
  ]);
}

export function decisionFor(
  runId: string,
  options: { readonly type?: string; readonly minutes: number },
): Record<string, unknown> {
  return {
    runId,
    decisionId: `${runId}/review-1`,
    type: options.type ?? "approval",
    allowed: options.type === "question" ? ["answer"] : ["approve", "deny"],
    prompt: "Approve the drafted issue.",
    revision: 1,
    generation: 1,
    subjectDigest: "sha256:abc",
    openedAt: minutesBefore(options.minutes),
  };
}

export function draftRun(minutes: number): Record<string, unknown> {
  return floorRun("draft", {
    workflowId: "idea",
    operation: "write-draft",
    minutes: minutes + 3,
    state: "waiting_gate",
  });
}

export function mergeRun(pausedMinutes: number): Record<string, unknown> {
  return floorRun("merge", {
    operation: "github-merge",
    minutes: pausedMinutes + 9,
    state: "paused",
    ticketId: "540",
    reason: {
      code: "operator-pause",
      detail: "The operator paused the run.",
    },
    pausedMinutes,
  });
}

export function needsModel(minutes: {
  readonly decision: number;
  readonly stopped: number;
}) {
  return floorModel(
    [
      draftRun(minutes.decision),
      mergeRun(minutes.stopped),
      floorRun("busy", { operation: "claude-turn", minutes: 90 }),
    ],
    { decisions: [decisionFor("draft", { minutes: minutes.decision })] },
  );
}
