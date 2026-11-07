import assert from "node:assert/strict";
import { test } from "node:test";
import {
  finishedModel,
  type FinishedChecks,
} from "../src/cli/watch-finished.ts";
import { needsOf } from "../src/cli/watch-needs-view.ts";
import { record } from "../src/protocol.ts";
import { items } from "./service-fixture.ts";
import type { WatchModel, WatchRun } from "../src/cli/watch-render.ts";
import { boardRun } from "./watch-board-fixture.ts";
import { floorModel, minutesBefore } from "./watch-floor-fixture.ts";

const repository = {
  host: "github.com",
  owner: "cloving-ai",
  repository: "cloving-ai",
};

interface StoppedOptions {
  readonly ticketId: string;
  readonly state?: string;
  readonly outcome?: string;
  readonly createdMinutes?: number;
  readonly endedMinutes?: number;
  readonly continuedBy?: string;
}

function stoppedRun(
  runId: string,
  options: StoppedOptions,
): Record<string, unknown> {
  const created = minutesBefore(options.createdMinutes ?? 60);
  const run = boardRun(runId, {
    state: options.state ?? "completed",
    outcome: options.outcome ?? "blocked",
    ticketId: options.ticketId,
    latestAt: minutesBefore(options.endedMinutes ?? 30),
    events: [
      { sequence: 1, recordedAt: created, type: "run.created" },
      {
        sequence: 2,
        recordedAt: minutesBefore(options.endedMinutes ?? 30),
        type: options.state === "failed" ? "run.failed" : "run.completed",
      },
    ],
  });
  const status = run["status"];
  return {
    ...run,
    status: {
      ...(typeof status === "object" ? status : {}),
      ...(options.continuedBy === undefined
        ? {}
        : { continuedBy: options.continuedBy }),
    },
  };
}

function withTickets(model: WatchModel): WatchModel {
  return {
    ...model,
    runs: model.runs.map((run): WatchRun => ({
      ...run,
      issueIdentity: { ...repository, number: Number(run.ticketId) },
      pullRequest: {
        number: Number(run.ticketId) + 100,
        url: `https://github.com/cloving-ai/cloving-ai/pull/${String(Number(run.ticketId) + 100)}`,
      },
    })),
  };
}

const openChecks: FinishedChecks = {
  issue: () => "open",
  pullRequest: () => ({ status: "unmerged" }),
  retentionDays: null,
};

function listed(model: WatchModel, checks: FinishedChecks): readonly string[] {
  return needsOf(finishedModel(withTickets(model), checks).runs).map(
    (need) => need.runId,
  );
}

await test("CLV-321 Needs you leaves out a blocked run of a closed ticket and a blocked run with a merged pull request", () => {
  const model = floorModel([
    stoppedRun("closed-ticket", { ticketId: "586" }),
    stoppedRun("merged-pull", { ticketId: "590" }),
    stoppedRun("open-ticket", { ticketId: "592" }),
  ]);
  const checks: FinishedChecks = {
    issue: (issue) => (issue.number === 586 ? "closed" : "open"),
    pullRequest: (pull) => ({
      status: pull.number === 690 ? "merged" : "unmerged",
    }),
    retentionDays: null,
  };
  assert.deepEqual(listed(model, checks), ["open-ticket"]);
  assert.deepEqual(
    finishedModel(withTickets(model), checks)
      .runs.map((run) => [run.runId, run.finished ?? null])
      .toSorted(),
    [
      ["closed-ticket", "ticket-closed"],
      ["merged-pull", "pull-request-merged"],
      ["open-ticket", null],
    ],
  );
});

await test("CLV-321 Needs you leaves out a failed run of a ticket with a later completed run", () => {
  const model = floorModel([
    stoppedRun("failed-first", {
      ticketId: "471",
      state: "failed",
      createdMinutes: 300,
      endedMinutes: 240,
    }),
    stoppedRun("completed-later", {
      ticketId: "471",
      outcome: "handoff_requested",
      createdMinutes: 200,
      endedMinutes: 100,
    }),
    stoppedRun("failed-other", {
      ticketId: "514",
      state: "failed",
      createdMinutes: 50,
    }),
    stoppedRun("completed-earlier", {
      ticketId: "514",
      outcome: "handoff_requested",
      createdMinutes: 400,
      endedMinutes: 350,
    }),
  ]);
  assert.deepEqual(listed(model, openChecks), ["failed-other"]);
});

function withOutcome(
  run: ReturnType<typeof stoppedRun>,
  fields: Readonly<Record<string, string>>,
): ReturnType<typeof stoppedRun> {
  const status = record(run["status"]) ?? {};
  return {
    ...run,
    status: { ...status, outcome: { ...record(status["outcome"]), ...fields } },
  };
}

await test("CLV-321 a later run with partial work or a failed issue update does not finish the ticket", () => {
  const later = (runId: string, ticketId: string) =>
    stoppedRun(runId, {
      ticketId,
      outcome: "handoff_requested",
      createdMinutes: 200,
      endedMinutes: 100,
    });
  const first = (runId: string, ticketId: string) =>
    stoppedRun(runId, {
      ticketId,
      state: "failed",
      createdMinutes: 300,
      endedMinutes: 240,
    });
  const model = floorModel([
    first("failed-partial", "309"),
    withOutcome(later("partial-later", "309"), { ticketStatus: "partial" }),
    first("failed-update", "313"),
    withOutcome(later("update-later", "313"), { issueUpdate: "failed" }),
    first("failed-complete", "320"),
    withOutcome(later("complete-later", "320"), { ticketStatus: "complete" }),
  ]);
  assert.deepEqual(listed(model, openChecks).toSorted(), [
    "failed-partial",
    "failed-update",
  ]);
});

await test("CLV-321 Needs you leaves out a stopped run that ended more than the retention days ago", () => {
  const model = floorModel([
    stoppedRun("old-run", {
      ticketId: "261",
      createdMinutes: 4 * 1440,
      endedMinutes: 3 * 1440 + 1,
    }),
    stoppedRun("young-run", {
      ticketId: "266",
      createdMinutes: 3 * 1440,
      endedMinutes: 3 * 1440 - 1,
    }),
  ]);
  assert.deepEqual(listed(model, { ...openChecks, retentionDays: 3 }), [
    "young-run",
  ]);
  assert.deepEqual(listed(model, openChecks), ["old-run", "young-run"]);
});

await test("CLV-321 a run with a continuation or no stop reads no ticket and no pull request", () => {
  const reads: string[] = [];
  const model = floorModel([
    stoppedRun("continued", { ticketId: "175", continuedBy: "run-new" }),
    stoppedRun("handed-off", {
      ticketId: "176",
      outcome: "handoff_requested",
    }),
  ]);
  const shown = finishedModel(withTickets(model), {
    issue: (issue) => {
      reads.push(`issue ${String(issue.number)}`);
      return "closed";
    },
    pullRequest: (pull) => {
      reads.push(`pull ${String(pull.number)}`);
      return { status: "merged" };
    },
    retentionDays: 1,
  });
  assert.deepEqual(reads, []);
  assert.deepEqual(
    shown.runs.map((run) => run.finished ?? null),
    [null, null],
  );
});

await test("CLV-321 a dismissed run leaves Needs you and reads no ticket and no pull request", () => {
  const reads: string[] = [];
  const dismissed = stoppedRun("dismissed", {
    ticketId: "175",
    state: "failed",
  });
  const model = floorModel([
    {
      ...dismissed,
      events: [
        ...items(dismissed["events"]),
        { sequence: 3, recordedAt: minutesBefore(5), type: "run.dismissed" },
      ],
    },
    stoppedRun("kept", { ticketId: "176", state: "failed" }),
  ]);
  const shown = finishedModel(withTickets(model), {
    issue: (issue) => {
      reads.push(`issue ${String(issue.number)}`);
      return "open";
    },
    pullRequest: (pull) => {
      reads.push(`pull ${String(pull.number)}`);
      return { status: "unmerged" };
    },
    retentionDays: null,
  });
  assert.deepEqual(reads, ["issue 176", "pull 276"]);
  assert.deepEqual(
    Object.fromEntries(
      shown.runs.map((run) => [run.runId, run.finished ?? null]),
    ),
    { dismissed: "dismissed", kept: null },
  );
  assert.deepEqual(
    needsOf(shown.runs).map((need) => need.runId),
    ["kept"],
  );
});
