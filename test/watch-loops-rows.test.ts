import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { loopRows, loopRunsOf } from "../src/cli/watch-loops.ts";
import { loopLastText, relativeText } from "../src/cli/watch-loops-view.ts";

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

await test("CLV-328 a relative time is now, minutes, hours or days, before or after now", () => {
  const now = "2026-11-16T13:00:00.000Z";
  const at = (minutes: number): string =>
    new Date(Date.parse(now) + minutes * 60000).toISOString();
  assert.equal(relativeText(now, now), "now");
  assert.equal(relativeText(at(30), now), "in 30 min");
  assert.equal(relativeText(at(-90), now), "2 h ago");
  assert.equal(relativeText(at(3 * 1440), now), "in 3 d");
  assert.equal(
    loopLastText({
      runId: "run-1",
      state: "running",
      outcome: null,
      endedAt: null,
    }),
    "running",
  );
});
