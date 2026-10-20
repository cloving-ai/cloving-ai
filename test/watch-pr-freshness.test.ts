import assert from "node:assert/strict";
import { test } from "node:test";
import { Card } from "../src/cli/watch-board-view.ts";
import { observedBoard } from "../src/cli/watch-pr-board.ts";
import { component } from "../src/cli/watch-element.ts";
import type { PrObserver } from "../src/cli/watch-pr-observer.ts";
import type { WatchModel } from "../src/cli/watch-render.ts";
import { boardModel, boardRun, boardTime } from "./watch-board-fixture.ts";
import { rendered } from "./watch-dom.ts";
import { played } from "./watch-browser.ts";
import type { PrObservation } from "../src/cli/watch-pr-identity.ts";
import {
  fakePrClock,
  observing,
  prOutput,
  recordedPr,
  settleObservation,
} from "./watch-pr-fixture.ts";

function stoppedModel(): WatchModel {
  const model = boardModel([
    boardRun("A /&<b>", { state: "completed", outcome: "blocked" }),
  ]);
  return {
    ...model,
    runs: model.runs.map((run) => ({ ...run, pullRequest: recordedPr })),
  };
}

function shown(
  model: WatchModel,
  context: {
    readonly observer: PrObserver;
    readonly clock: ReturnType<typeof fakePrClock>;
  },
): string {
  const { observer, clock } = context;
  const observed = observedBoard(model, observer);
  const card = observed.workflows.flatMap((workflow) =>
    workflow.columns.flatMap((column) => column.cards),
  )[0];
  assert.ok(card);
  return rendered(
    component(Card, {
      card: { ...card, pullRequestNumber: 7 },
      workflowId: "develop-issue",
      now: new Date(clock.now()).toISOString(),
    }),
  );
}

await test("CLV-129 first checks, stale unmerged replies, failed refreshes and fresh replies have distinct text", async () => {
  const model = stoppedModel();
  const before = JSON.stringify(model);
  const clock = fakePrClock();
  clock.advance(Date.parse(boardTime) - clock.now());
  const { observer, attempts } = observing(clock);
  try {
    assert.match(shown(model, { observer, clock }), />Checking PR<\/span>/);
    await settleObservation();
    clock.advance(1000);
    attempts[0]?.finish(prOutput(false));
    await settleObservation();
    assert.match(shown(model, { observer, clock }), />Needs attention<\/span>/);
    clock.advance(120000);
    assert.doesNotMatch(shown(model, { observer, clock }), />Stale</);
    await settleObservation();
    clock.advance(1);
    assert.match(
      shown(model, { observer, clock }),
      />Needs attention<\/span> <span class="completion-stale">Stale<\/span>/,
    );
    attempts[1]?.reject(new Error("private upstream error"));
    await settleObservation();
    const failed = shown(model, { observer, clock });
    assert.match(
      failed,
      />PR status unavailable<\/span> <span class="completion-stale">Stale<\/span>/,
    );
    assert.doesNotMatch(failed, /Checking PR|private upstream/);
    clock.advance(60000);
    assert.match(shown(model, { observer, clock }), />PR status unavailable</);
    await settleObservation();
    attempts[2]?.finish(prOutput(false));
    await settleObservation();
    const fresh = shown(model, { observer, clock });
    assert.match(fresh, />Needs attention<\/span>/);
    assert.doesNotMatch(fresh, />Stale<|Checking PR|PR status unavailable/);
    assert.match(fresh, /Title of A \/&amp;&lt;b&gt;/);
    assert.match(
      fresh,
      /href="#workflow=develop-issue&amp;run=A%20%2F%26%3Cb%3E"/,
    );
    assert.equal(JSON.stringify(model), before);
    assert.equal(model.runs[0]?.outcome, "blocked");
  } finally {
    observer.close();
  }
});

await test("CLV-129 confirmed merges render exact text and never become stale or refresh", async () => {
  const clock = fakePrClock();
  clock.advance(Date.parse(boardTime) - clock.now());
  const { observer, attempts } = observing(clock);
  const model = stoppedModel();
  try {
    shown(model, { observer, clock });
    await settleObservation();
    attempts[0]?.finish(prOutput(true));
    await settleObservation();
    clock.advance(120001);
    const html = shown(model, { observer, clock });
    assert.match(html, /<span class="completion-mark">PR merged · #7<\/span>/);
    assert.doesNotMatch(html, />Stale<|Checking PR|Needs attention/);
    await settleObservation();
    assert.equal(attempts.length, 1);
  } finally {
    observer.close();
  }
});

const now = Date.parse(boardTime);
const staleSuccess = { status: "unmerged", readAt: now - 120001 } as const;
const observations = new Map<string, PrObservation>([
  ["pending", { status: "pending" }],
  [
    "fresh",
    {
      status: "unmerged",
      lastSuccess: { status: "unmerged", readAt: now - 120000 },
    },
  ],
  ["stale", { status: "unmerged", lastSuccess: staleSuccess }],
  [
    "failed",
    { status: "unavailable", failure: "command", lastSuccess: staleSuccess },
  ],
  [
    "merged",
    {
      status: "merged",
      lastSuccess: { status: "merged", readAt: now - 120001 },
    },
  ],
]);

await test("CLV-129 the embedded browser renders pending, stale, unavailable and merged PR marks", () => {
  const base = boardModel(
    [...observations.keys()].map((runId) =>
      boardRun(runId, { state: "completed", outcome: "blocked" }),
    ),
  );
  const model = {
    ...base,
    workflows: base.workflows.map((workflow) => ({
      ...workflow,
      columns: workflow.columns.map((column) => ({
        ...column,
        cards: column.cards.map((card) => ({
          ...card,
          pullRequestNumber: 7,
          pullRequestObservation: observations.get(card.runId) ?? null,
        })),
      })),
    })),
  };
  const result = played(
    model,
    `
location.hash = "#workflow=develop-issue";
replies.push(JSON.parse(process.env.WATCH_MODEL));
await load();
app.all("button").find((node) => node.attributes.get("aria-label") === "Expand Stopped")?.dispatch("click");
console.log(JSON.stringify({ html: app.inner }));
`,
  );
  const html = String(result["html"]);
  assert.match(html, />Checking PR<\/span>/);
  assert.equal(html.match(/>Needs attention<\/span>/g)?.length, 2);
  assert.equal(
    html.match(/class="completion-stale">Stale<\/span>/g)?.length,
    2,
  );
  assert.match(html, />PR status unavailable<\/span>/);
  assert.match(html, />PR merged · #7<\/span>/);
});
