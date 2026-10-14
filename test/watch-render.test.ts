import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clockTime,
  counted,
  elapsed,
  groupActivity,
  pageTitle,
  turnTime,
  type WatchItem,
} from "../src/cli/watch-render.ts";
import {
  at,
  phases,
  reviewedTurn,
  sampleModel,
  sampleRun,
  sampleTurn,
  shownClock,
} from "./watch-sample.ts";

const item = (kind: string): WatchItem => ({ kind, text: kind });

await test("CLV-016 the watch page shows a time span in seconds, in minutes or in hours, a clock time in the local time zone and a count with its noun", () => {
  assert.deepEqual(
    [
      elapsed(at("21:26:00"), at("21:26:42")),
      elapsed(at("21:26:00"), at("21:33:38")),
      elapsed(at("21:26:00"), at("22:30:59")),
      elapsed(at("21:26:00"), at("21:25:00")),
      elapsed("", at("21:25:00")),
    ],
    ["42 s", "7 min 38 s", "1 h 4 min", "0 s", ""],
  );
  assert.deepEqual(
    [clockTime(at("21:26:00")), clockTime("no time")],
    [shownClock("21:26:00"), ""],
  );
  assert.deepEqual(
    [counted(0, "commit"), counted(1, "commit"), counted(2, "commit")],
    ["0 commits", "1 commit", "2 commits"],
  );
});

await test("CLV-016 the watch page puts the tool calls and the tool errors between two messages of the worker into one group", () => {
  const kinds = ["say", "tool", "tool", "error", "tool", "say", "tool"];
  assert.deepEqual(
    groupActivity([...kinds, "result", "error", "tool"].map(item)).map(
      (group) => group.map((member) => member.kind).join(" "),
    ),
    ["say", "tool tool error tool", "say", "tool", "result", "error tool"],
  );
  assert.deepEqual(groupActivity([]), []);
});

await test("CLV-016 the watch page gives a turn in work a time span to the present time, a turn at its end the span to its end, and a turn with no end time no span", () => {
  assert.deepEqual(
    [
      turnTime(sampleTurn(), at("21:26:44")),
      turnTime(reviewedTurn, at("21:40:00")),
      turnTime(sampleTurn({ outcome: "failed" }), at("21:40:00")),
    ],
    ["42 s", "7 min 38 s", ""],
  );
});

await test("CLV-016 the title of the watch page shows the state of the selected run and the count of the runs that wait for a decision", () => {
  const waiting = sampleRun();
  const done = sampleRun({
    runId: "run-2",
    state: "completed",
    decisions: [],
    turns: [],
    phases: phases(["done", "done", "done", "done", "done"]),
  });
  const model = sampleModel([done, waiting]);
  assert.deepEqual(
    [
      pageTitle(model, "run-1"),
      pageTitle(model, ""),
      pageTitle(sampleModel([done]), "run-9"),
      pageTitle(sampleModel([{ ...done, decision: "denied" }]), ""),
      pageTitle(sampleModel([]), ""),
    ],
    [
      "(1) ! Needs your decision · clv-016-a6f7ef47 · Cloving",
      "(1) ✓ Completed · run-2 · Cloving",
      "✓ Completed · run-2 · Cloving",
      "✕ Denied · run-2 · Cloving",
      "Cloving",
    ],
  );
});
