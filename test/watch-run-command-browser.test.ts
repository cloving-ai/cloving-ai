import assert from "node:assert/strict";
import { test } from "node:test";
import { floorModel, floorRun } from "./watch-floor-fixture.ts";
import { watchPageServer } from "./watch-page-server.ts";
import { realBrowser } from "./watch-real-browser.ts";

const ready = `(async () => {
  const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  for (let attempt = 0; attempt < 300 && !document.querySelector(".need .run-command-drop"); attempt++) await frame();
  return { tokens: document.querySelectorAll(".tokens .token-menu").length };
})()`;

const focused = `(async () => {
  await new Promise((resolve) => requestAnimationFrame(resolve));
  const node = document.activeElement;
  return {
    name: node.getAttribute("class"),
    place: node.closest(".run-command")?.getAttribute("data-place") ?? null,
    questions: document.querySelectorAll(".drop-question").length,
  };
})()`;

await test("CLV-335 Drop and Keep it in Needs you move the keyboard focus inside the copy that the person pressed, not into the closed menu of the station token", async () => {
  const model = floorModel([
    floorRun("paused-run", {
      operation: "github-merge",
      minutes: 20,
      state: "paused",
      pausedMinutes: 10,
    }),
  ]);
  await using fixture = await watchPageServer(model, { token: "a".repeat(64) });
  await using browser = await realBrowser();
  const page = await browser.page({ width: 1280, height: 844 });
  await page.navigate(fixture.url);
  assert.deepEqual(await page.evaluate(ready), { tokens: 1 });
  await page.click(".need .run-command-drop");
  const asked = await page.evaluate(focused);
  await page.click(".need .drop-keep");
  const kept = await page.evaluate(focused);
  assert.deepEqual(
    [asked, kept],
    [
      { name: "drop-keep", place: "need", questions: 1 },
      { name: "run-command-drop", place: "need", questions: 0 },
    ],
  );
});

const dropped = `(async () => {
  const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  for (let attempt = 0; attempt < 300 && !document.querySelector(":is(.board, .floor) > .run-command-message"); attempt++) await frame();
  const line = document.querySelector(":is(.board, .floor) > .run-command-message");
  const box = line.getBoundingClientRect();
  const columns = document.querySelector(".columns")?.getBoundingClientRect().height ?? null;
  return {
    text: line.textContent,
    place: line.parentElement.getAttribute("class"),
    small: box.height > 0 && box.height < 40,
    inside: box.left >= 0 && box.right <= innerWidth,
    columns: columns === null ? null : columns > 300,
    controls: document.querySelectorAll(".run-command").length,
  };
})()`;

await test("CLV-335 after Drop the run from a card menu or a station token menu, the board or the floor shows the reply in one small line, and the board columns keep their height", async () => {
  const run = (state: string) => {
    const shown = floorRun("run-a", { operation: "claude-turn", minutes: 5 });
    const status = shown["status"];
    return floorModel([
      {
        ...shown,
        state,
        status: {
          ...(typeof status === "object" ? status : {}),
          revision: 4,
          state,
        },
      },
    ]);
  };
  const reply = {
    kind: "run-command",
    command: "drop",
    committed: { state: "cancelled", revision: 5 },
  };
  const results = [];
  for (const [hash, place, opener] of [
    ["#workflow=develop-issue", ".card", ".run-menu summary"],
    ["", ".tokens", ".token-menu-open"],
  ] as const) {
    await using fixture = await watchPageServer(run("running"), {
      token: "a".repeat(64),
      hash,
      actions: { "/actions/drop": { reply, next: run("cancelled") } },
    });
    await using browser = await realBrowser();
    const page = await browser.page({ width: 1280, height: 844 });
    await page.navigate(fixture.url);
    await page.evaluate(ready.replace(".need .run-command-drop", place));
    await page.click(`${place} ${opener}`);
    await page.click(`${place} .run-command-drop`);
    await page.click(`${place} .drop-confirm`);
    results.push(await page.evaluate(dropped));
  }
  const line = {
    text: "Title of run-a: Dropped",
    small: true,
    inside: true,
    controls: 0,
  };
  assert.deepEqual(results, [
    { ...line, place: "board", columns: true },
    { ...line, place: "floor", columns: null },
  ]);
});
