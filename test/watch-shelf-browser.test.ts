import assert from "node:assert/strict";
import { test } from "node:test";
import { floorModel } from "./watch-floor-fixture.ts";
import { watchPageServer } from "./watch-page-server.ts";
import { realBrowser } from "./watch-real-browser.ts";
import {
  attachedRecord,
  completedRun,
  demoUrl,
} from "./watch-shelf-fixture.ts";

const longRun =
  "a-run-with-a-long-title-that-needs-more-than-two-lines-of-the-tile";

const measure = `(async () => {
  const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  for (let attempt = 0; attempt < 300 && !document.querySelector(".tile"); attempt++) await frame();
  const list = document.querySelector(".tiles");
  const tiles = [...document.querySelectorAll(".tile")];
  const title = document.querySelector('.tile-title[href="#run=${longRun}"]');
  return {
    pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    sideways: list.scrollWidth > list.clientWidth,
    row: new Set(tiles.map((tile) => tile.getBoundingClientRect().top)).size,
    edges: tiles.map((tile) => ({
      workflow: tile.querySelector(".tile-facts span").textContent,
      color: getComputedStyle(tile).borderLeftColor,
      width: getComputedStyle(tile).borderLeftWidth,
    })),
    lines: Object.fromEntries([...document.querySelectorAll(".line-name")].map((name) => [
      name.querySelector("a").textContent,
      getComputedStyle(name, "::before").backgroundColor,
    ])),
    titleLines: title.getBoundingClientRect().height / parseFloat(getComputedStyle(title).lineHeight),
    clamped: title.scrollHeight > title.clientHeight,
  };
})()`;

const playing = `(async () => {
  const pause = () => new Promise((resolve) => setTimeout(resolve, 100));
  const calls = [];
  HTMLMediaElement.prototype.play = function () { calls.push("play"); return Promise.resolve(); };
  HTMLMediaElement.prototype.pause = function () { calls.push("pause"); };
  const button = document.querySelector(".tile-demo");
  button.click();
  await pause();
  const player = document.getElementById(button.getAttribute("popovertarget"));
  const video = player.querySelector("video");
  const opened = {
    open: player.matches(":popover-open"),
    source: video.getAttribute("src"),
    wide: video.getBoundingClientRect().width >= 600,
    calls: [...calls],
  };
  player.hidePopover();
  await pause();
  return { opened, open: player.matches(":popover-open"), calls };
})()`;

function shelfRuns(now: number) {
  return Array.from({ length: 6 }, (_, index) =>
    completedRun(index === 0 ? longRun : `run-${String(index)}`, {
      ticketId: String(580 + index),
      workflowId: index % 2 === 0 ? "develop-issue" : "idea",
      createdAt: new Date(now - (index + 2) * 60000).toISOString(),
      completedAt: new Date(now + 60000 - index * 1000).toISOString(),
    }),
  );
}

await test("CLV-288 at a width of 390 px the shelf scrolls sideways, and each tile edge has the color of its workflow line", async () => {
  const now = Date.now();
  const model = floorModel(shelfRuns(now), {
    updatedAt: new Date(now).toISOString(),
  });
  await using fixture = await watchPageServer(model, "");
  await using browser = await realBrowser();
  const page = await browser.page({ width: 390, height: 844 });
  await page.navigate(fixture.url);
  const result = await page.evaluate(measure);
  assert.equal(result["pageOverflow"], 0);
  assert.equal(result["sideways"], true);
  assert.equal(result["row"], 1);
  const lines = result["lines"];
  assert.ok(typeof lines === "object" && lines !== null);
  assert.notEqual(
    Reflect.get(lines, "develop-issue"),
    Reflect.get(lines, "idea"),
  );
  const edges = result["edges"];
  assert.ok(Array.isArray(edges));
  assert.equal(edges.length, 6);
  for (const edge of edges) {
    assert.ok(typeof edge === "object" && edge !== null);
    assert.equal(
      Reflect.get(edge, "color"),
      Reflect.get(lines, Reflect.get(edge, "workflow")),
      JSON.stringify(edge),
    );
    assert.equal(Reflect.get(edge, "width"), "5px");
  }
  assert.ok(Number(result["titleLines"]) <= 2.05, String(result["titleLines"]));
  assert.equal(result["clamped"], true);
});

await test("CLV-288 Play demo opens a player of the demo on the page, which plays, and a close of the player stops the video", async () => {
  const now = Date.now();
  const model = floorModel(shelfRuns(now), {
    updatedAt: new Date(now).toISOString(),
    githubRecords: [
      attachedRecord("run-1", { number: 581, name: "demo.mp4", url: demoUrl }),
    ],
  });
  await using fixture = await watchPageServer(model, "");
  await using browser = await realBrowser();
  const page = await browser.page({ width: 1280, height: 800 });
  await page.navigate(fixture.url);
  await page.evaluate(measure);
  const result = await page.evaluate(playing);
  assert.deepEqual(result["opened"], {
    open: true,
    source: demoUrl,
    wide: true,
    calls: ["play"],
  });
  assert.equal(result["open"], false);
  assert.deepEqual(result["calls"], ["play", "pause"]);
});
