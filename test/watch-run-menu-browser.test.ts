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
    label: "#726",
    title:
      "Find commit signatures that a turn cannot make before the first run",
    phases: phases(["done", "done", "active"]),
    turns: [sampleTurn()],
  }),
]);

const frames = `const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));`;

const ready = `(async () => {
  ${frames}
  for (let attempt = 0; attempt < 300 && !document.querySelector(".run-more-open"); attempt++) await frame();
  return {};
})()`;

const menuShown = `(async () => {
  ${frames}
  await frame();
  return { menu: getComputedStyle(document.querySelector(".run-more-menu")).visibility };
})()`;

const afterPick = `(async () => {
  ${frames}
  await frame();
  await frame();
  const cancel = [...document.querySelectorAll(".banner .rename-form button")].find((node) => node.textContent === "Cancel");
  const box = cancel.getBoundingClientRect();
  const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
  return {
    menu: getComputedStyle(document.querySelector(".run-more-menu")).visibility,
    focus: document.activeElement.getAttribute("name"),
    cancelOnTop: hit === cancel,
    cancelShown: box.width > 0 && box.height > 0,
  };
})()`;

const afterCancel = `(async () => {
  ${frames}
  await frame();
  await frame();
  return {
    form: document.querySelector(".banner .rename-form") !== null,
    menu: getComputedStyle(document.querySelector(".run-more-menu")).visibility,
    focus: document.activeElement.getAttribute("class"),
  };
})()`;

await test("CLV-357 Rename in the ⋯ menu closes the menu at once while the pointer rests on it, puts the focus in the title, and Cancel is on top and closes the form", async () => {
  await using fixture = await watchPageServer(model, {
    hash: "#run=run-7",
    token: "a".repeat(64),
  });
  await using browser = await realBrowser();
  const page = await browser.page({ width: 1280, height: 800 });
  await page.navigate(fixture.url);
  await page.evaluate(ready);
  await page.click(".run-more-open");
  assert.deepEqual(await page.evaluate(menuShown), { menu: "visible" });
  await page.click(".run-more-menu .rename-open");
  assert.deepEqual(await page.evaluate(afterPick), {
    menu: "hidden",
    focus: "title",
    cancelOnTop: true,
    cancelShown: true,
  });
  await page.click('.banner .rename-form button[type="button"]');
  assert.deepEqual(await page.evaluate(afterCancel), {
    form: false,
    menu: "hidden",
    focus: "name-edit",
  });
});
