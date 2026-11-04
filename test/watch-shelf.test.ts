import assert from "node:assert/strict";
import { test } from "node:test";
import { component } from "../src/cli/watch-element.ts";
import type { WatchModel } from "../src/cli/watch-render.ts";
import { Page } from "../src/cli/watch-view.ts";
import { played } from "./watch-browser.ts";
import { rendered } from "./watch-dom.ts";
import { floorModel } from "./watch-floor-fixture.ts";
import { noCopy } from "./watch-sample.ts";
import {
  attachedRecord,
  completedRun,
  demoUrl,
  localTime,
  pullRecord,
  shelfModel,
} from "./watch-shelf-fixture.ts";

process.env["TZ"] = "America/Los_Angeles";

function page(model: WatchModel, now = model.updatedAt): string {
  return rendered(
    component(Page, {
      model,
      selected: "",
      now,
      stale: false,
      copying: noCopy,
    }),
  );
}

function shelf(html: string): string {
  return /<section class="shelf"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
}

function tiles(html: string): readonly string[] {
  return shelf(html)
    .split('<li class="tile')
    .slice(1)
    .map((tile) => `<li class="tile${tile.replace(/<\/ol>[\s\S]*$/, "")}`);
}

const demoLink = `<button class="tile-demo" type="button" popovertarget="demo-early" aria-label="Play demo of #475"><video class="demo-frame" src="${demoUrl}#t=0.1" preload="metadata" aria-hidden="true"></video>Play demo</button><div id="demo-early" class="demo-player" popover="auto"><video src="${demoUrl}" controls preload="none"></video></div>`;

await test("CLV-288 three runs that completed today show three tiles, the newest first, each with its ticket, pull request, workflow, time and cost", () => {
  const html = page(shelfModel());
  assert.match(
    shelf(html),
    /^<section class="shelf" aria-labelledby="shelf-title"><div class="shelf-head"><h2 id="shelf-title">Completed today<\/h2><span class="shelf-count">3 runs<\/span><\/div><ol class="tiles">/,
  );
  assert.deepEqual(tiles(html), [
    '<li class="tile line-color-1"><div class="tile-ids"><span class="tile-ticket">#477</span><span class="tile-pull">PR #577</span></div><a class="tile-title" href="#run=late" title="Title of late">Title of late</a><div class="tile-facts"><span>develop-issue</span><span>2 h 34 min</span><span>1.25 USD</span></div></li>',
    '<li class="tile line-color-2"><div class="tile-ids"><span class="tile-ticket">Draft</span></div><a class="tile-title" href="#run=draft" title="Title of draft">Title of draft</a><div class="tile-facts"><span>idea</span><span>30 min 0 s</span><span>1.25 USD</span></div></li>',
    `<li class="tile line-color-1"><div class="tile-ids"><span class="tile-ticket">#475</span><span class="tile-pull">PR #580</span></div><a class="tile-title" href="#run=early" title="Title of early">Title of early</a><div class="tile-facts"><span>develop-issue</span><span>3 h 44 min</span><span>1.25 USD</span></div>${demoLink}</li>`,
  ]);
});

await test("CLV-288 a run with no demo shows a complete tile with no Play demo", () => {
  const records = [
    attachedRecord("late", {
      number: 577,
      name: "screen.png",
      url: "https://github.com/user-attachments/assets/screen-577",
    }),
    attachedRecord("late", {
      number: 577,
      name: "failed.mp4",
      url: "https://github.com/user-attachments/assets/failed-577",
      outcome: "failed",
    }),
    attachedRecord("draft", {
      number: 1,
      name: "plain.webm",
      url: "http://github.example/plain.webm",
    }),
  ];
  const base = shelfModel();
  const model = floorModel(
    [
      completedRun("late", {
        ticketId: "477",
        createdAt: localTime(0, "09:00"),
        completedAt: localTime(0, "11:34"),
      }),
      completedRun("draft", {
        workflowId: "idea",
        createdAt: localTime(0, "10:30"),
        completedAt: localTime(0, "11:00"),
      }),
    ],
    {
      updatedAt: base.updatedAt,
      githubRecords: [pullRecord("late", 577), ...records],
    },
  );
  const shown = tiles(page(model));
  assert.equal(shown.length, 2);
  for (const tile of shown) {
    assert.doesNotMatch(tile, /Play demo|<video|tile-demo/);
    assert.match(
      tile,
      /<div class="tile-ids">[\s\S]*<a class="tile-title"[\s\S]*<div class="tile-facts"><span>[^<]+<\/span><span>[^<]+<\/span><span>1\.25 USD<\/span><\/div><\/li>$/,
    );
  }
});

await test("CLV-288 a run that attached a demo shows Play demo, which opens a player of the demo on the page", () => {
  const html = page(shelfModel());
  const [, , early = ""] = tiles(html);
  assert.ok(early.endsWith(`${demoLink}</li>`), early);
  const served = played(
    shelfModel(),
    `
const model = JSON.parse(process.env.WATCH_MODEL);
location.hash = "";
replies.push(model);
await load();
const demo = app.all("button").find((item) => item.attributes.get("class") === "tile-demo");
const player = app.all("div").find((item) => item.attributes.get("id") === demo?.attributes.get("popovertarget"));
console.log(JSON.stringify({ html: app.inner, popover: player?.attributes.get("popover"), source: player?.all("video")[0]?.attributes.get("src"), toggle: player?.listeners.has("toggle") }));
`,
  );
  assert.equal(served["popover"], "auto");
  assert.equal(served["source"], demoUrl);
  assert.equal(served["toggle"], true);
  assert.match(
    JSON.stringify(served["html"]),
    /<h2 id=\\"shelf-title\\">Completed today<\/h2><span class=\\"shelf-count\\">3 runs<\/span>/,
  );
});

await test("CLV-288 a run that completed before local midnight shows no tile", () => {
  const html = page(shelfModel());
  assert.doesNotMatch(shelf(html), /#470|yesterday|PR #571/);
  const runs = [
    completedRun("midnight", {
      ticketId: "480",
      createdAt: localTime(-1, "23:00"),
      completedAt: localTime(0, "00:00"),
    }),
    completedRun("before", {
      ticketId: "479",
      createdAt: localTime(-1, "22:00"),
      completedAt: localTime(-1, "23:59"),
    }),
  ];
  const shown = tiles(
    page(floorModel(runs, { updatedAt: localTime(0, "12:00") })),
  );
  assert.equal(shown.length, 1);
  assert.match(shown[0] ?? "", /#480/);
  const next = floorModel(runs, { updatedAt: localTime(1, "00:01") });
  assert.equal(tiles(page(next)).length, 0);
});

await test("CLV-288 the shelf starts the day at local midnight of the computer that runs the service, not of the browser", () => {
  process.env["TZ"] = "UTC";
  const model = floorModel(
    [
      completedRun("service-today", {
        ticketId: "481",
        createdAt: "2026-10-14T02:00:00.000Z",
        completedAt: "2026-10-14T03:00:00.000Z",
      }),
      completedRun("service-yesterday", {
        ticketId: "478",
        createdAt: "2026-10-13T22:00:00.000Z",
        completedAt: "2026-10-13T23:00:00.000Z",
      }),
    ],
    { updatedAt: "2026-10-14T12:00:00.000Z" },
  );
  process.env["TZ"] = "America/Los_Angeles";
  const shown = tiles(page(model));
  assert.equal(shown.length, 1);
  assert.match(shown[0] ?? "", /#481/);
});

await test("CLV-288 of the runs of today, only a completed run that is not blocked shows a tile", () => {
  const today = {
    createdAt: localTime(0, "08:00"),
    completedAt: localTime(0, "09:00"),
  };
  const model = floorModel(
    [
      completedRun("done", today),
      completedRun("blocked", { ...today, outcome: "blocked" }),
      completedRun("failed", { ...today, state: "failed" }),
      completedRun("active", { ...today, state: "running" }),
    ],
    { updatedAt: localTime(0, "12:00") },
  );
  const shown = tiles(page(model));
  assert.equal(shown.length, 1);
  assert.match(shown[0] ?? "", /href="#run=done"/);
});

await test("CLV-288 a partial run shows no tile, so the shelf count agrees with the Today panel", () => {
  const today = {
    createdAt: localTime(0, "08:00"),
    completedAt: localTime(0, "09:00"),
  };
  const model = floorModel(
    [
      completedRun("done", { ...today, ticketStatus: "complete" }),
      completedRun("partial", { ...today, ticketStatus: "partial" }),
    ],
    { updatedAt: localTime(0, "12:00") },
  );
  const shown = tiles(page(model));
  assert.equal(shown.length, 1);
  assert.match(shown[0] ?? "", /href="#run=done"/);
});

await test("CLV-288 with no completed run the shelf says No run completed today", () => {
  const html = page(floorModel([], { updatedAt: localTime(0, "12:00") }));
  assert.equal(
    shelf(html),
    '<section class="shelf" aria-labelledby="shelf-title"><div class="shelf-head"><h2 id="shelf-title">Completed today</h2><span class="shelf-count">0 runs</span></div><p class="meta">No run completed today.</p></section>',
  );
});

await test("CLV-288 a tile takes the color of the line of its workflow, and no color when its workflow has no line", () => {
  const today = {
    createdAt: localTime(0, "08:00"),
    completedAt: localTime(0, "09:00"),
  };
  const model = floorModel(
    [
      completedRun("idea-run", { ...today, workflowId: "idea" }),
      completedRun("gone", { ...today, workflowId: "removed-workflow" }),
    ],
    { updatedAt: localTime(0, "12:00") },
  );
  const classes = tiles(page(model)).map(
    (tile) => /^<li class="([^"]*)"/.exec(tile)?.[1],
  );
  assert.deepEqual(classes.toSorted(), ["tile", "tile line-color-2"]);
});
