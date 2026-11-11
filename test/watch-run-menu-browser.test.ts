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
  for (let attempt = 0; attempt < 300 && !document.querySelector(".run-head-actions .token-menu-open"); attempt++) await frame();
  return {};
})()`;

const menuShown = `(async () => {
  ${frames}
  await frame();
  return { menu: (document.querySelector("#run-menu-run-7").matches(":popover-open") ? "visible" : "hidden") };
})()`;

const afterPick = `(async () => {
  ${frames}
  await frame();
  await frame();
  const cancel = [...document.querySelectorAll(".banner .rename-form button")].find((node) => node.textContent === "Cancel");
  const box = cancel.getBoundingClientRect();
  const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
  return {
    menu: (document.querySelector("#run-menu-run-7").matches(":popover-open") ? "visible" : "hidden"),
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
    menu: (document.querySelector("#run-menu-run-7").matches(":popover-open") ? "visible" : "hidden"),
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
  await page.click(".run-head-actions .token-menu-open");
  assert.deepEqual(await page.evaluate(menuShown), { menu: "visible" });
  await page.click("#run-menu-run-7 .rename-open");
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

const focusOn = (selector: string) => `(async () => {
  ${frames}
  await frame();
  document.querySelector(${JSON.stringify(selector)}).focus();
  await frame();
  return {};
})()`;

const place = `(async () => {
  ${frames}
  await frame();
  await frame();
  return {
    focus: document.activeElement.getAttribute("class") ?? document.activeElement.getAttribute("name"),
    menu: (document.querySelector("#run-menu-run-7").matches(":popover-open") ? "visible" : "hidden"),
    asking: document.querySelector(".drop-question") !== null,
    form: document.querySelector(".banner .rename-form") !== null,
  };
})()`;

await test("CLV-357 with the keyboard, Keep it gives the focus to ⋯ with the menu closed, Enter on ⋯ opens the menu, and Escape in the rename form gives the focus to the pencil", async () => {
  await using fixture = await watchPageServer(model, {
    hash: "#run=run-7",
    token: "a".repeat(64),
  });
  await using browser = await realBrowser();
  const page = await browser.page({ width: 1280, height: 800 });
  await page.navigate(fixture.url);
  await page.evaluate(ready);
  await page.evaluate(focusOn(".run-head-actions .token-menu-open"));
  await page.evaluate(focusOn("#run-menu-run-7 .run-command-drop"));
  await page.press({ key: "Enter", code: 13, text: "\r" });
  assert.deepEqual(await page.evaluate(place), {
    focus: "drop-keep",
    menu: "hidden",
    asking: true,
    form: false,
  });
  await page.press({ key: "Enter", code: 13, text: "\r" });
  assert.deepEqual(await page.evaluate(place), {
    focus: "token-menu-open",
    menu: "hidden",
    asking: false,
    form: false,
  });
  await page.press({ key: "Enter", code: 13, text: "\r" });
  assert.deepEqual(await page.evaluate(place), {
    focus: "token-menu-open",
    menu: "visible",
    asking: false,
    form: false,
  });
  await page.evaluate(focusOn("#run-menu-run-7 .rename-open"));
  await page.press({ key: "Enter", code: 13, text: "\r" });
  assert.deepEqual(await page.evaluate(place), {
    focus: "title",
    menu: "hidden",
    asking: false,
    form: true,
  });
  await page.press({ key: "Escape", code: 27 });
  assert.deepEqual(await page.evaluate(place), {
    focus: "name-edit",
    menu: "hidden",
    asking: false,
    form: false,
  });
});
