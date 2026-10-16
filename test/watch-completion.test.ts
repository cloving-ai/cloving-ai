import assert from "node:assert/strict";
import { test } from "node:test";
import { completionMarkOf } from "../src/cli/watch-board.ts";
import type { WatchRun } from "../src/cli/watch-render.ts";
import { completionScenario } from "./watch-board-fixture.ts";

function scenario(): { readonly stopped: WatchRun; readonly later: WatchRun } {
  const runs = completionScenario().runs;
  const stopped = runs.find((run) => run.runId === "A");
  const later = runs.find((run) => run.runId === "B");
  assert.ok(stopped);
  assert.ok(later);
  return { stopped, later };
}

const attention = { text: "Needs attention", laterRunId: null };
const done = { text: "Done in a later run", laterRunId: "B" };

await test("CLV-091 the rule only marks completed blocked issue runs", () => {
  const { stopped, later } = scenario();
  for (const changes of [
    { workflowId: "develop-ticket" },
    { workflowId: "develop-prompt" },
    ...["running", "waiting_gate", "paused", "failed", "cancelled"].map(
      (state) => ({ state }),
    ),
    ...["handoff_requested", "completed", null].map((outcome) => ({ outcome })),
  ])
    assert.equal(completionMarkOf({ ...stopped, ...changes }, [later]), null);
  assert.deepEqual(completionMarkOf(stopped, []), attention);
  assert.deepEqual(completionMarkOf(stopped, [later]), done);
});

await test("CLV-091 only a different completed issue run with the exact ticket ID and handoff outcome qualifies", () => {
  const { stopped, later } = scenario();
  const rejected: Partial<WatchRun>[] = [
    { runId: stopped.runId },
    ...["DEMO-2", "demo-1", " DEMO-1", "DEMO-1 ", "", null].map((ticketId) => ({
      ticketId,
    })),
    ...["develop-ticket", "develop-prompt"].map((workflowId) => ({
      workflowId,
    })),
    ...["running", "waiting_gate", "paused", "failed", "cancelled"].map(
      (state) => ({ state }),
    ),
    ...["blocked", "completed", "approved", null].map((outcome) => ({
      outcome,
    })),
  ];
  for (const changes of rejected)
    assert.deepEqual(
      completionMarkOf(stopped, [{ ...later, ...changes }]),
      attention,
      JSON.stringify(changes),
    );
  for (const ticketId of [null, ""])
    assert.deepEqual(
      completionMarkOf({ ...stopped, ticketId }, [{ ...later, ticketId }]),
      attention,
    );
  assert.deepEqual(
    completionMarkOf({ ...stopped, ticketId: " " }, [
      { ...later, ticketId: " " },
    ]),
    done,
  );
});

await test("CLV-091 event evidence must establish creation strictly after stopped completion", () => {
  const { stopped, later } = scenario();
  for (const recordedAt of [
    "2026-10-14T09:59:59Z",
    "2026-10-14T10:00:00Z",
    "invalid",
    "",
  ])
    assert.deepEqual(
      completionMarkOf(stopped, [
        {
          ...later,
          events: [{ sequence: 1, type: "run.created", recordedAt }],
        },
      ]),
      attention,
    );
  for (const events of [
    [],
    [{ sequence: 1, type: "run.started", recordedAt: "2026-10-14T10:01:00Z" }],
  ])
    assert.deepEqual(
      completionMarkOf(stopped, [{ ...later, events }]),
      attention,
    );
  for (const events of [
    [],
    [{ sequence: 1, type: "run.completed", recordedAt: "invalid" }],
    [{ sequence: 1, type: "run.started", recordedAt: "2026-10-14T10:00:00Z" }],
  ])
    assert.deepEqual(
      completionMarkOf({ ...stopped, events }, [later]),
      attention,
    );
  assert.deepEqual(
    completionMarkOf({ ...stopped, title: "Other", latestAt: "2099-01-01" }, [
      { ...later, title: "Different", latestAt: "2000-01-01", turns: [] },
    ]),
    done,
  );
});

function frozen(run: WatchRun): WatchRun {
  return Object.freeze({
    ...run,
    events: Object.freeze(
      run.events.map((event) => Object.freeze({ ...event })),
    ),
  });
}

await test("CLV-091 impossible dates and incomplete timestamps cannot establish a later creation", () => {
  const { stopped, later } = scenario();
  for (const recordedAt of [
    "2026-11-31T10:01:00Z",
    "2026-10-14T24:00:00Z",
    "2026-10-15",
  ])
    assert.deepEqual(
      completionMarkOf(stopped, [
        {
          ...later,
          events: [{ sequence: 1, type: "run.created", recordedAt }],
        },
      ]),
      attention,
      recordedAt,
    );
});

await test("CLV-091 impossible dates and incomplete timestamps cannot establish stopped completion", () => {
  const { stopped, later } = scenario();
  for (const recordedAt of [
    "2026-09-31T10:00:00Z",
    "2026-02-29T10:00:00Z",
    "2026-10-14",
  ])
    assert.deepEqual(
      completionMarkOf(
        {
          ...stopped,
          events: [{ sequence: 1, type: "run.completed", recordedAt }],
        },
        [later],
      ),
      attention,
      recordedAt,
    );
});

await test("CLV-091 the pure rule chooses earliest creation then ascending run ID without changing frozen input", () => {
  const { stopped, later } = scenario();
  const candidates = Object.freeze([
    frozen({
      ...later,
      runId: "newest",
      events: [
        {
          sequence: 1,
          type: "run.created",
          recordedAt: "2026-10-14T10:02:00Z",
        },
      ],
    }),
    frozen({ ...later, runId: "b" }),
    frozen({ ...later, runId: "a" }),
  ]);
  const original = JSON.stringify(candidates);
  for (const runs of [candidates, candidates.toReversed()])
    assert.deepEqual(completionMarkOf(frozen(stopped), runs), {
      text: "Done in a later run",
      laterRunId: "a",
    });
  assert.equal(JSON.stringify(candidates), original);
});
