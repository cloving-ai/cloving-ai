import assert from "node:assert/strict";
import { test } from "node:test";
import { component } from "../src/cli/watch-element.ts";
import type { WatchModel } from "../src/cli/watch-render.ts";
import { Page } from "../src/cli/watch-view.ts";
import type { DailyNumbers } from "../src/report-days.ts";
import { played } from "./watch-browser.ts";
import { rendered } from "./watch-dom.ts";
import { twoLineModel } from "./watch-floor-fixture.ts";
import { noCopy } from "./watch-sample.ts";

const today: DailyNumbers = {
  completed: 3,
  stopped: 1,
  costUsd: 25,
  unknownCostRuns: 0,
  costPerCompletedRunUsd: 25 / 3,
  yesterday: { completed: 1, costUsd: 8, unknownCostRuns: 0 },
  days: [
    { date: "2026-10-29", completed: 0 },
    { date: "2026-10-30", completed: 0 },
    { date: "2026-10-31", completed: 0 },
    { date: "2026-11-01", completed: 0 },
    { date: "2026-11-02", completed: 1 },
    { date: "2026-11-03", completed: 1 },
    { date: "2026-11-04", completed: 3 },
  ],
  workflows: [
    {
      workflowId: "develop-issue",
      completed: 2,
      costUsd: 24.5,
      unknownCostRuns: 0,
    },
    { workflowId: "idea", completed: 1, costUsd: 0.5, unknownCostRuns: 0 },
    { workflowId: "review-day", completed: 0, costUsd: 0, unknownCostRuns: 0 },
  ],
};

function todayModel(changes: Partial<WatchModel> = {}): WatchModel {
  return {
    ...twoLineModel(),
    today,
    queue: { workflowId: "develop-issue", state: "running", busy: 3, lanes: 4 },
    ...changes,
  };
}

function panel(model: WatchModel): string {
  const html = rendered(
    component(Page, {
      model,
      selected: "",
      now: model.updatedAt,
      stale: false,
      copying: noCopy,
    }),
  );
  return /<section class="today"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
}

await test("CLV-289 the Today panel shows the completed runs, the cost, the cost per completed run and the stopped runs, with the values of yesterday", () => {
  const html = panel(todayModel());
  assert.match(
    html,
    /^<section class="today" aria-labelledby="today-title"><div class="today-head"><h2 id="today-title">Today<\/h2><span class="today-since">since midnight<\/span><\/div>/,
  );
  assert.match(
    html,
    /<div class="today-numbers"><div class="today-number"><strong>3<\/strong><span class="today-label">runs completed<\/span><span class="today-yesterday">1 yesterday<\/span><\/div><div class="today-number"><strong>\$25\.00<\/strong><span class="today-label">spent<\/span><span class="today-yesterday">\$8\.00 yesterday<\/span><\/div><div class="today-number"><strong>\$8\.33<\/strong><span class="today-label">per completed run<\/span><\/div><div class="today-number"><strong>1<\/strong><span class="today-label">stopped<\/span><\/div><\/div>/,
  );
});

await test("CLV-321 with runs that have no cost, the Today panel and the lines show the known spend as at least, with the count of runs with no cost", () => {
  const html = panel(
    todayModel({
      today: {
        ...today,
        costUsd: 129.93,
        unknownCostRuns: 4,
        costPerCompletedRunUsd: 43.31,
        yesterday: { completed: 1, costUsd: 8, unknownCostRuns: 1 },
        workflows: [
          {
            workflowId: "develop-issue",
            completed: 2,
            costUsd: 120,
            unknownCostRuns: 3,
          },
          {
            workflowId: "idea",
            completed: 1,
            costUsd: 9.93,
            unknownCostRuns: 1,
          },
        ],
      },
    }),
  );
  assert.match(
    html,
    /<div class="today-number"><strong>at least \$129\.93<\/strong><span class="today-label">spent<\/span><span class="today-yesterday">at least \$8\.00 yesterday<\/span><span class="today-unknown">4 runs with no cost<\/span><\/div>/,
  );
  assert.match(
    html,
    /<strong>\$43\.31<\/strong><span class="today-label">per completed run<\/span>/,
  );
  assert.match(
    html,
    /<th scope="row">develop-issue<\/th><td>2<\/td><td>at least \$120\.00<\/td>/,
  );
  assert.match(
    html,
    /<th scope="row">idea<\/th><td>1<\/td><td>at least \$9\.93<\/td>/,
  );
});

await test("CLV-289 a day with no completed run shows no cost per completed run", () => {
  const html = panel(
    todayModel({
      today: {
        ...today,
        completed: 0,
        costPerCompletedRunUsd: null,
      },
    }),
  );
  assert.match(
    html,
    /<strong>-<\/strong><span class="today-label">per completed run<\/span>/,
  );
  assert.doesNotMatch(html, /today-unknown|at least/);
});

await test("CLV-289 the chart shows seven bars with the completed runs of each day, today last", () => {
  const html = panel(todayModel());
  assert.match(
    html,
    /<h3>Last 7 days<\/h3><svg class="today-chart" xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 280 132" role="img" aria-label="Completed runs: Thu 0, Fri 0, Sat 0, Sun 0, Mon 1, Tue 1, Wed 3">/,
  );
  const bars = [
    ...html.matchAll(
      /<g class="([^"]+)"><rect x="(\d+)" y="(\d+)" width="32" height="(\d+)"><\/rect><text class="today-count" x="\d+" y="\d+">(\d+)<\/text><text class="today-day" x="\d+" y="124">(\w+)<\/text><\/g>/g,
    ),
  ].map((match) => match.slice(1));
  assert.deepEqual(bars, [
    ["today-bar", "4", "104", "0", "0", "Thu"],
    ["today-bar", "44", "104", "0", "0", "Fri"],
    ["today-bar", "84", "104", "0", "0", "Sat"],
    ["today-bar", "124", "104", "0", "0", "Sun"],
    ["today-bar", "164", "75", "29", "1", "Mon"],
    ["today-bar", "204", "75", "29", "1", "Tue"],
    ["today-bar current", "244", "16", "88", "3", "Wed"],
  ]);
});

await test("CLV-289 the table has one row for each workflow with its completed runs and its cost of today", () => {
  const html = panel(todayModel());
  assert.match(
    html,
    /<h3>By line<\/h3><table class="today-table"><thead><tr><th scope="col">Line<\/th><th scope="col">Done<\/th><th scope="col">Spent<\/th><\/tr><\/thead><tbody><tr><th scope="row">develop-issue<\/th><td>2<\/td><td>\$24\.50<\/td><\/tr><tr><th scope="row">idea<\/th><td>1<\/td><td>\$0\.50<\/td><\/tr><tr><th scope="row">review-day<\/th><td>0<\/td><td>\$0\.00<\/td><\/tr><\/tbody><\/table>/,
  );
});

await test("CLV-289 the queue line shows one mark for each lane, busy or free", () => {
  const html = panel(todayModel());
  assert.match(
    html,
    /<p class="today-queue"><span>Queue running, 3 of 4 lanes busy<\/span><span class="lanes" aria-hidden="true"><span class="lane busy"><\/span><span class="lane busy"><\/span><span class="lane busy"><\/span><span class="lane free"><\/span><\/span><\/p><\/section>$/,
  );
  assert.doesNotMatch(
    panel(todayModel({ queue: { workflowId: "develop-issue" } })),
    /today-queue/,
  );
  assert.doesNotMatch(panel({ ...twoLineModel(), today }), /today-queue/);
});

await test("CLV-289 the floor has no Today panel without the numbers of the day", () => {
  assert.equal(panel(twoLineModel()), "");
});

await test("CLV-289 the served page shows the Today panel at the side of the floor", () => {
  const result = played(
    todayModel(),
    `
const model = JSON.parse(process.env.WATCH_MODEL);
location.hash = "";
replies.push(model);
await load();
console.log(JSON.stringify({ html: app.inner }));
`,
  );
  const html = String(result["html"]);
  assert.match(
    html,
    /<aside class="side-panels"><section class="today" aria-labelledby="today-title">/,
  );
  assert.match(
    html,
    /aria-label="Completed runs: Thu 0, Fri 0, Sat 0, Sun 0, Mon 1, Tue 1, Wed 3"/,
  );
  assert.match(html, /<span>Queue running, 3 of 4 lanes busy<\/span>/);
});
