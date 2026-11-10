import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { loopRows, loopRunsOf } from "../src/cli/watch-loops.ts";
import {
  lastRunText,
  loopLastText,
  loopTime,
} from "../src/cli/watch-loops-view.ts";

const hourly = {
  workflowId: "hourly",
  everySeconds: 7200,
  state: "active",
  failuresInRow: 0,
  nextAt: null,
  stoppedAt: null,
} as const;

await test("CLV-328 a loop row gives the rule in hours, and an active last run has no end time and no outcome", () => {
  assert.deepEqual(
    loopRows(
      [hourly],
      [
        {
          runId: "run-active",
          workflowId: "hourly",
          state: "running",
          scheduled: { slot: 2 },
        },
      ],
    ),
    [
      {
        workflowId: "hourly",
        rule: "every 2 h",
        state: "active",
        nextAt: null,
        failuresInRow: 0,
        lastRun: {
          runId: "run-active",
          state: "running",
          outcome: null,
          endedAt: null,
        },
      },
    ],
  );
});

await test("CLV-328 loops are empty with no schedules or unavailable schedules", async () => {
  assert.deepEqual(loopRows(undefined, []), []);
  assert.deepEqual(loopRows({ status: "unavailable" }, []), []);
  const read = { summaries: [], runs: [] };
  assert.deepEqual(await loopRunsOf("unused", read), []);
  assert.deepEqual(
    await loopRunsOf("unused", {
      ...read,
      schedules: { status: "unavailable" },
    }),
    [],
  );
});

await test("CLV-328 when the service does not answer the status of the last run, the loop keeps the summary of the run", async () => {
  const summary = {
    runId: "run-old",
    workflowId: "hourly",
    state: "failed",
    manualFromLoop: true,
  };
  assert.deepEqual(
    await loopRunsOf(join(tmpdir(), "clv-328-no-service"), {
      schedules: [hourly],
      summaries: [summary, { runId: "other", workflowId: "hourly" }],
      runs: [],
    }),
    [summary],
  );
});

await test("CLV-340 the last run of a loop shows a short end time with a mark, and a run that did not end shows in work", () => {
  const now = "2026-11-16T20:00:00.000Z";
  const run = (state: string, endedAt: string | null) => ({
    runId: "run-1",
    state,
    outcome: null,
    endedAt,
  });
  const clock = (at: string): string =>
    new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const today = "2026-11-16T18:00:00.000Z";
  const yesterday = "2026-11-15T20:00:00.000Z";
  const older = "2026-11-10T20:00:00.000Z";
  assert.equal(
    lastRunText(run("completed", today), now),
    `last run ${clock(today)} ✓`,
  );
  assert.equal(
    lastRunText(run("failed", yesterday), now),
    `last run ${clock(yesterday)} yesterday · failed`,
  );
  assert.equal(
    lastRunText(run("cancelled", older), now),
    `last run ${loopTime(older)} · cancelled`,
  );
  assert.equal(lastRunText(run("running", null), now), "last run in work");
  assert.equal(loopLastText(run("running", null)), "running");
});
