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
