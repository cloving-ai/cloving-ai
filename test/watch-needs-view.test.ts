import assert from "node:assert/strict";
import { test } from "node:test";
import { component } from "../src/cli/watch-element.ts";
import type { WatchModel } from "../src/cli/watch-render.ts";
import { Page } from "../src/cli/watch-view.ts";
import { played } from "./watch-browser.ts";
import { rendered } from "./watch-dom.ts";
import {
  decisionFor,
  draftRun,
  floorModel,
  floorRun,
  mergeRun,
  needsModel,
} from "./watch-floor-fixture.ts";
import { noCopy } from "./watch-sample.ts";

function page(model: WatchModel, selected = ""): string {
  return rendered(
    component(Page, {
      model,
      selected,
      now: model.updatedAt,
      stale: false,
      copying: noCopy,
    }),
  );
}

function panel(html: string): string {
  return /<section class="needs"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
}

const decisionItem =
  '<li class="need need-decision"><span class="need-mark" title="Decision"></span><div class="need-body"><h3 class="need-title">Title of draft</h3><p class="need-text">Examine the work, then approve or deny it.</p><p class="need-meta">idea, waiting 12m</p></div><a class="need-action" href="#run=draft&amp;decision=draft%2Freview-1">Answer</a></li>';

const stoppedItem =
  '<li class="need need-stopped"><span class="need-mark" title="Stopped run"></span><div class="need-body"><h3 class="need-title"><span class="need-label">#540</span> Title of merge</h3><p class="need-text">Examine the run, then resume or drop it.</p><p class="need-reason">Why it paused: operator-pause: The operator paused the run.</p><p class="need-meta">develop-issue, waiting 51m</p></div><a class="need-action" href="#run=merge">Open run</a></li>';

const fullPanel = `<section class="needs" aria-labelledby="needs-title"><div class="needs-head"><h2 id="needs-title">Needs you</h2><span class="needs-count">2 waiting for a person</span></div><ol class="needs-list">${stoppedItem}${decisionItem}</ol></section>`;

await test("CLV-287 a Needs you panel under the floor lists a decision and a stopped run, each with one action", () => {
  const html = page(needsModel({ decision: 12, stopped: 51 }));
  assert.match(
    html,
    /<div class="floor-main"><section class="floor"[\s\S]*?<\/section><section class="needs"/,
  );
  assert.equal(panel(html), fullPanel);
});

await test("CLV-287 the item that waited longest comes first", () => {
  const html = panel(page(needsModel({ decision: 90, stopped: 5 })));
  assert.deepEqual(
    [...html.matchAll(/<li class="need need-(\w+)">/g)].map(
      (match) => match[1],
    ),
    ["decision", "stopped"],
  );
  assert.match(html, /idea, waiting 1h 30m/);
  assert.match(html, /develop-issue, waiting 5m/);
});

await test("CLV-287 with no decision and no stopped run, the panel says that nothing needs you", () => {
  const model = floorModel([
    floorRun("busy", { operation: "claude-turn", minutes: 4 }),
  ]);
  assert.equal(
    panel(page(model)),
    '<section class="needs" aria-labelledby="needs-title"><div class="needs-head"><h2 id="needs-title">Needs you</h2><span class="needs-count">0 waiting for a person</span></div><p class="needs-empty">Nothing needs you.</p></section>',
  );
});

await test("CLV-287 Answer opens the decision form of the run, and Open run opens the run detail with the stop reason", () => {
  const model = needsModel({ decision: 12, stopped: 51 });
  const answer = page(model, "run=draft");
  assert.match(answer, /<a class="banner-back" href="#">← Floor<\/a>/);
  assert.match(
    answer,
    /<section class="decision" id="decision-draft\/review-1"><h3>Your decision · approval · waiting 12m<\/h3>[\s\S]*Approve the drafted issue\./,
  );
  const stopped = page(model, "run=merge");
  assert.match(
    stopped,
    /<section class="banner attention">[\s\S]*Paused[\s\S]*Why it paused: operator-pause: The operator paused the run\./,
  );
});

await test("CLV-287 a question and an untyped decision each say what the person must do", () => {
  const model = floorModel(
    [
      draftRun(20),
      floorRun("ask", { workflowId: "idea", state: "waiting_gate" }),
    ],
    {
      decisions: [
        decisionFor("draft", { type: "question", minutes: 20 }),
        decisionFor("ask", { type: "untyped", minutes: 8 }),
      ],
    },
  );
  assert.deepEqual(
    [...panel(page(model)).matchAll(/<p class="need-text">([^<]*)</g)].map(
      (match) => match[1],
    ),
    [
      "Read the question, then answer it.",
      "Examine the request, then give your decision.",
    ],
  );
});

await test("CLV-287 a decision with no open time shows no wait and comes last", () => {
  const model = floorModel([draftRun(5), mergeRun(3)], {
    decisions: [{ ...decisionFor("draft", { minutes: 5 }), openedAt: "" }],
  });
  const html = panel(page(model));
  assert.deepEqual(
    [...html.matchAll(/<p class="need-meta">([^<]*)</g)].map(
      (match) => match[1],
    ),
    ["develop-issue, waiting 3m", "idea"],
  );
});

await test("CLV-287 the served page shows the Needs you panel under the floor", () => {
  const served = played(
    needsModel({ decision: 12, stopped: 51 }),
    `
const model = JSON.parse(process.env.WATCH_MODEL);
location.hash = "";
replies.push(model);
await load();
console.log(JSON.stringify({ html: app.inner }));
`,
  );
  assert.equal(panel(String(served["html"])), fullPanel);
});

await test("CLV-321 with 3 decisions and 2 stopped runs in Needs you, the header shows 5 need you", () => {
  const model = floorModel(
    [
      floorRun("first", { workflowId: "idea", operation: "write-draft" }),
      floorRun("second", { workflowId: "idea", operation: "write-draft" }),
      floorRun("third", { workflowId: "idea", operation: "write-draft" }),
      mergeRun(20),
      floorRun("failed", { operation: "github-merge", state: "failed" }),
    ],
    {
      decisions: ["first", "second", "third"].map((runId) =>
        decisionFor(runId, { minutes: 10 }),
      ),
    },
  );
  const header =
    /<span class="header-count needs-you"><strong>5<\/strong> need you<\/span>/;
  assert.match(page(model), header);
  assert.match(panel(page(model)), /5 waiting for a person/);
  const served = played(
    model,
    `
const model = JSON.parse(process.env.WATCH_MODEL);
location.hash = "";
replies.push(model);
await load();
console.log(JSON.stringify({ html: app.inner }));
`,
  );
  assert.match(String(served["html"]), header);
});

await test("CLV-321 a stopped run that a direct link reads outside the floor does not count in the header", () => {
  const [archived] = floorModel([
    floorRun("old-stopped", { operation: "github-merge", state: "failed" }),
  ]).runs;
  assert.ok(archived);
  const served = played(
    { ...floorModel([]), archived },
    `
const { archived, ...model } = JSON.parse(process.env.WATCH_MODEL);
location.hash = "#run=old-stopped";
replies.push(model, { run: archived });
await load();
const linked = app.inner;
location.hash = "";
replies.push(model);
listeners.hashchange();
const floor = app.inner;
await settled();
console.log(JSON.stringify({ linked, floor, runs: state.model.runs.length }));
`,
  );
  const none =
    /<span class="header-count needs-you"><strong>0<\/strong> need you<\/span>/;
  assert.match(
    String(served["linked"]),
    /<span class="name-title">[^<]*<\/span>(?:<button[^>]*>✎<\/button>)?<\/h2><p class="run-status">Failed/,
  );
  assert.match(String(served["linked"]), none);
  assert.match(String(served["floor"]), none);
  assert.match(String(served["floor"]), /Nothing needs you/);
  assert.equal(served["runs"], 0);
});
