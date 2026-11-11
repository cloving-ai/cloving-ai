import assert from "node:assert/strict";
import { test } from "node:test";
import { watchPageServer } from "./watch-page-server.ts";
import { realBrowser } from "./watch-real-browser.ts";
import { phases, sampleModel, sampleRun, sampleTurn } from "./watch-sample.ts";

const model = sampleModel([
  sampleRun({
    runId: "run-7",
    state: "running",
    code: "run-running",
    detail: "The run is in work.",
    decisions: [],
    phases: phases(["done", "done", "active"]),
    turns: [sampleTurn()],
  }),
  sampleRun({
    runId: "run-8",
    state: "running",
    code: "run-running",
    detail: "The run is in work.",
    decisions: [],
    phases: phases(["done", "done", "active"]),
    turns: [
      sampleTurn({
        activity: [
          {
            kind: "say",
            text: `## Result **Header:** ${"the run page now puts the run first, with one action bar and the details in tabs, ".repeat(8)}\n\nThe second line.`,
          },
        ],
      }),
    ],
  }),
]);

const ready = `(async () => {
  const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  for (let attempt = 0; attempt < 300 && !document.querySelector("#run-tab-events"); attempt++) await frame();
  return {};
})()`;

const firstEvent = `(async () => {
  const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  for (let attempt = 0; attempt < 120 && document.querySelector("#run-tab-events").getAttribute("aria-selected") !== "true"; attempt++) await frame();
  await frame();
  const row = document.querySelector("#run-panel-events .event");
  const box = row.getBoundingClientRect();
  const hit = document.elementFromPoint(box.left + 4, box.top + box.height / 2);
  return {
    selected: document.querySelector("#run-tab-events").getAttribute("aria-selected"),
    shown: box.width > 0 && box.height > 0 && getComputedStyle(row).visibility === "visible",
    onTop: hit === row,
    text: row.textContent.endsWith("run.created"),
    disclosures: document.querySelectorAll("#run-panel-events details").length,
  };
})()`;

await test("CLV-357 a click on the Events tab shows the first event row at once, with no further click", async () => {
  await using fixture = await watchPageServer(model, { hash: "#run=run-7" });
  await using browser = await realBrowser();
  const page = await browser.page({ width: 1280, height: 800 });
  await page.navigate(fixture.url);
  await page.evaluate(ready);
  await page.click("#run-tab-events");
  assert.deepEqual(await page.evaluate(firstEvent), {
    selected: "true",
    shown: true,
    onTop: true,
    text: true,
    disclosures: 0,
  });
});

const liveLine = `(async () => {
  const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  for (let attempt = 0; attempt < 300 && !document.querySelector(".banner .now"); attempt++) await frame();
  await frame();
  const banner = document.querySelector(".banner").getBoundingClientRect();
  const line = document.querySelector(".banner .now");
  const box = line.getBoundingClientRect();
  const main = document.querySelector(".banner-main").getBoundingClientRect();
  return {
    inside: box.right <= banner.right && main.right <= banner.right,
    oneLine: box.height < 30,
    clipped: line.scrollWidth > line.clientWidth,
    page: document.documentElement.scrollWidth <= innerWidth,
    text: line.textContent.startsWith("Result Header: the run page"),
    title: line.title.startsWith("## Result **Header:**"),
  };
})()`;

await test("CLV-357 a long Markdown output keeps the live line of the banner on one line inside the banner, at a wide and a narrow width", async () => {
  await using fixture = await watchPageServer(model, { hash: "#run=run-8" });
  await using browser = await realBrowser();
  for (const width of [1280, 600]) {
    const page = await browser.page({ width, height: 800 });
    await page.navigate(fixture.url);
    assert.deepEqual(await page.evaluate(liveLine), {
      inside: true,
      oneLine: true,
      clipped: true,
      page: true,
      text: true,
      title: true,
    });
  }
});
