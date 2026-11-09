import assert from "node:assert/strict";
import { test } from "node:test";
import { component } from "../src/cli/watch-element.ts";
import type { LoopControls } from "../src/cli/watch-loops-view.ts";
import { loopMessage } from "../src/cli/watch-loops-view.ts";
import type { WatchModel } from "../src/cli/watch-render.ts";
import { Page, Run } from "../src/cli/watch-view.ts";
import { Card } from "../src/cli/watch-board-view.ts";
import { boardModel, boardTime } from "./watch-board-fixture.ts";
import { found, rendered } from "./watch-dom.ts";
import { floorModel } from "./watch-floor-fixture.ts";
import {
  loopEndedAt as endedAt,
  loopModel,
  loopNextAt as nextAt,
  loopNow as now,
} from "./watch-loops-fixture.ts";
import { noCopy } from "./watch-sample.ts";

process.env["TZ"] = "America/Los_Angeles";

const shownTime = (at: string | number): string =>
  new Date(at).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

function called(handler: unknown): void {
  assert.ok(typeof handler === "function");
  Reflect.apply(handler, undefined, []);
}

function page(model: WatchModel, loops?: LoopControls): unknown {
  return component(Page, {
    model,
    selected: "",
    now,
    stale: false,
    copying: noCopy,
    loops,
  });
}

function panel(html: string): string {
  return /<section class="loops"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
}

function rows(html: string): readonly string[] {
  return [...panel(html).matchAll(/<li class="loop [\s\S]*?<\/li>/g)].map(
    (match) => match[0],
  );
}

const idle: LoopControls = {
  busy: [],
  messages: {},
  onSwitch: () => undefined,
  onRun: () => undefined,
};

await test("CLV-328 the Loops panel shows one row for each loop with its rule, state, next run in local and relative time, last run and failures", () => {
  const html = rendered(page(loopModel()));
  assert.match(
    html,
    /<aside class="side-panels">[\s\S]*<section class="loops" aria-labelledby="loops-title"><h2 id="loops-title">Loops<\/h2>/,
  );
  const [review, drift] = rows(html);
  assert.equal(
    review,
    `<li class="loop loop-active"><div class="loop-head"><a class="loop-workflow" href="#workflow=review-day">review-day</a><span class="loop-state">active</span></div><p class="loop-rule">every 30 min</p><p class="loop-next">Next run ${shownTime(nextAt)} · in 2 h</p><p class="loop-last">Last run <a href="#run=review-new">completed, handoff_requested, ended ${shownTime(endedAt)}</a></p><p class="loop-failures">0 failures in a row</p></li>`,
  );
  assert.match(review, /Next run [^<]*07:00/);
  assert.equal(
    drift,
    '<li class="loop loop-stopped"><div class="loop-head"><a class="loop-workflow" href="#workflow=docs-drift">docs-drift</a><span class="loop-state">stopped</span></div><p class="loop-rule">Mondays at 07:00 America/Los_Angeles</p><p class="loop-next">No next run</p><p class="loop-last">No run yet</p><p class="loop-failures">3 failures in a row</p></li>',
  );
});

await test("CLV-328 with watch actions, each row has a switch and a Run now button, and the switch sends pause for an active loop and resume for a stopped loop", () => {
  const sent: string[] = [];
  const controls: LoopControls = {
    busy: [],
    messages: { "docs-drift": "run-active: The workflow has an active run." },
    onSwitch: (workflowId, action) => {
      sent.push(`${action} ${workflowId}`);
    },
    onRun: (workflowId) => {
      sent.push(`run ${workflowId}`);
    },
  };
  const shown = page(loopModel(), controls);
  const switches = found(shown, "input");
  assert.deepEqual(
    switches.map((input) => [input["role"], input["checked"], input["type"]]),
    [
      ["switch", true, "checkbox"],
      ["switch", false, "checkbox"],
    ],
  );
  for (const input of switches) called(input["onChange"]);
  const buttons = found(shown, "button").filter(
    (button) => button["class"] === "loop-run",
  );
  assert.deepEqual(
    buttons.map((button) => button["children"]),
    ["Run now", "Run now"],
  );
  for (const button of buttons) called(button["onClick"]);
  assert.deepEqual(sent, [
    "pause review-day",
    "resume docs-drift",
    "run review-day",
    "run docs-drift",
  ]);
  const html = rendered(shown);
  assert.match(
    rows(html)[1] ?? "",
    /<p class="loop-message" role="status">run-active: The workflow has an active run\.<\/p><\/li>$/,
  );
  assert.match(
    rows(html)[0] ?? "",
    /<label class="loop-switch"><input[^>]*><\/input>On<\/label>/,
  );
  assert.match(
    rows(html)[1] ?? "",
    /<label class="loop-switch"><input[^>]*><\/input>Off<\/label>/,
  );
});

await test("CLV-328 a busy row disables its switch and its button", () => {
  const shown = page(loopModel(), { ...idle, busy: ["review-day"] });
  assert.deepEqual(
    found(shown, "input").map((input) => input["disabled"]),
    [true, false],
  );
  assert.deepEqual(
    found(shown, "button")
      .filter((button) => button["class"] === "loop-run")
      .map((button) => button["disabled"]),
    [true, false],
  );
});

await test("CLV-328 a floor with no loops has no Loops panel", () => {
  assert.equal(panel(rendered(page(floorModel([])))), "");
});

await test("CLV-328 the row message tells the reply of the service", () => {
  assert.equal(
    loopMessage({ kind: "schedule", schedule: { state: "paused" } }),
    "The loop is paused.",
  );
  assert.equal(
    loopMessage({ kind: "run-admitted", runId: "run-1", replayed: false }),
    "Run run-1 is admitted.",
  );
  assert.equal(
    loopMessage({ error: { code: "run-active", detail: "A run is active." } }),
    "run-active: A run is active.",
  );
  assert.equal(loopMessage(null), "The service gave no reply.");
});

await test("CLV-328 a run now is marked manual from loop on its card and in the run detail", () => {
  const model = boardModel(
    [
      {
        status: {
          runId: "loop-run",
          workflowId: "review-queue",
          state: "running",
          latestAt: boardTime,
          manualFromLoop: true,
        },
        events: [],
      },
    ],
    { workflows: ["review-queue"] },
  );
  const [run] = model.runs;
  const card = model.workflows[0]?.columns
    .flatMap((column) => column.cards)
    .find((candidate) => candidate.runId === "loop-run");
  assert.ok(run && card);
  assert.equal(run.manualFromLoop, true);
  assert.equal(card.manualFromLoop, true);
  const shownCard = rendered(
    component(Card, { card, workflowId: "review-queue", now: boardTime }),
  );
  assert.match(shownCard, /<span class="meta">manual from loop<\/span>/);
  const detail = rendered(
    component(Run, { run, now: boardTime, copying: noCopy }),
  );
  assert.match(detail, /<p class="meta">manual from loop<\/p>/);
});
