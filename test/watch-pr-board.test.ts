import assert from "node:assert/strict";
import { test } from "node:test";
import { observedBoard } from "../src/cli/watch-pr-board.ts";
import {
  boardModel,
  boardRun,
  completionScenario,
} from "./watch-board-fixture.ts";
import { recordedPr } from "./watch-pr-fixture.ts";
import type { WatchModel, WatchPullRequest } from "../src/cli/watch-render.ts";

function recorded(model: WatchModel): WatchModel {
  return {
    ...model,
    runs: model.runs.map((run) => ({ ...run, pullRequest: recordedPr })),
  };
}

await test("CLV-093 observations decorate retained unresolved cards without changing local marks or run state", () => {
  const model = recorded(completionScenario());
  const before = JSON.stringify(model);
  const calls: WatchPullRequest[] = [];
  const result = observedBoard(model, {
    observe: (pull) => {
      calls.push(pull);
      return { status: "merged" };
    },
    close: () => undefined,
  });
  assert.deepEqual(calls, [recordedPr]);
  const cards = result.workflows.flatMap((workflow) =>
    workflow.columns.flatMap((column) => column.cards),
  );
  assert.deepEqual(
    cards.find((card) => card.runId === "C")?.pullRequestObservation,
    { status: "merged" },
  );
  assert.deepEqual(cards.find((card) => card.runId === "C")?.completionMark, {
    text: "Needs attention",
    laterRunId: null,
  });
  assert.deepEqual(cards.find((card) => card.runId === "A")?.completionMark, {
    text: "Ticket completed by later run",
    laterRunId: "B",
  });
  assert.deepEqual(result.runs, model.runs);
  assert.equal(JSON.stringify(model), before);
});

await test("CLV-093 excluded outcomes, terminal states, missing PRs and retention limits cause no read", () => {
  const options = { state: "completed", outcome: "blocked" };
  const runs = [
    boardRun("failed", { ...options, state: "failed" }),
    boardRun("cancelled", { ...options, state: "cancelled" }),
    boardRun("done", { ...options, outcome: "handoff_requested" }),
    boardRun("ticket", { ...options, workflowId: "develop-ticket" }),
    boardRun("old", { ...options, latestAt: "2020-01-01T00:00:00Z" }),
    ...Array.from({ length: 25 }, (_, index) =>
      boardRun(`blocked-${String(index)}`, options),
    ),
  ];
  const model = recorded(boardModel(runs));
  let calls = 0;
  const result = observedBoard(model, {
    observe: () => {
      calls += 1;
      return null;
    },
    close: () => undefined,
  });
  const retained = result.workflows
    .flatMap((workflow) => workflow.columns.flatMap((column) => column.cards))
    .filter((card) => card.completionMark?.text === "Needs attention");
  assert.equal(calls, retained.length);
  assert.ok(calls > 0 && calls < 25);
  let withoutPrCalls = 0;
  observedBoard(boardModel(runs), {
    observe: () => {
      withoutPrCalls += 1;
      return null;
    },
    close: () => undefined,
  });
  assert.equal(withoutPrCalls, 0);
});
