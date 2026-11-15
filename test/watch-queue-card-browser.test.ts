import assert from "node:assert/strict";
import { test } from "node:test";
import { loopModel } from "./watch-loops-fixture.ts";
import { watchPageServer } from "./watch-page-server.ts";
import { realBrowser } from "./watch-real-browser.ts";

await test("CLV-377 the compact queue card retains row-end alignment and a visible meter in a real browser", async () => {
  const model = {
    ...loopModel(),
    queues: [
      {
        workflowId: "develop-issue",
        state: "running",
        busy: 6,
        lanes: 8,
        nextCheckAt: "2026-11-03T09:42:00.000Z",
        settings: {
          everySeconds: { value: 120, source: "declaration" },
          lanes: { value: 8, source: "environment" },
          workingLanes: { value: 8, source: "default" },
        },
      },
    ],
  };
  await using fixture = await watchPageServer(model, { token: "a".repeat(64) });
  await using browser = await realBrowser();
  const page = await browser.page({ width: 1600, height: 1000 });
  await page.navigate(fixture.url);
  const result = await page.evaluate(`(async () => {
    for (let frame = 0; frame < 300 && !document.querySelector(".line-queue"); frame++)
      await new Promise(requestAnimationFrame);
    const queue = document.querySelector(".line-queue");
    const loop = document.querySelector(".line-loop");
    if (!queue || !loop) return { missing: true };
    const box = (node) => { const rect = node.getBoundingClientRect(); return { left: rect.left, width: rect.width, height: rect.height }; };
    return {
      workflow: queue.closest(".line").querySelector(".line-name a").textContent,
      atEnd: queue.parentElement.className === "line-end" && queue.closest(".line").lastElementChild === queue.parentElement,
      queue: box(queue), loop: box(loop),
      shape: [queue, loop].map((node) => { const style = getComputedStyle(node); return [style.display, style.flexDirection, style.alignItems]; }),
      lanes: queue.querySelectorAll(".lane.busy").length,
      on: queue.querySelector('.queue-drain').textContent,
    };
  })()`);
  assert.equal(result["workflow"], "develop-issue");
  assert.equal(result["atEnd"], true);
  assertAlignedBoxes(result);
  assert.deepEqual(result["shape"], [
    ["flex", "column", "flex-end"],
    ["flex", "column", "flex-end"],
  ]);
  assert.equal(result["lanes"], 6);
  assert.equal(result["on"], "Drain");
});

function assertAlignedBoxes(result: Readonly<Record<string, unknown>>) {
  const queue = result["queue"];
  const loop = result["loop"];
  assert.equal(
    Number(Reflect.get(Object(queue), "left")) +
      Number(Reflect.get(Object(queue), "width")),
    Number(Reflect.get(Object(loop), "left")) +
      Number(Reflect.get(Object(loop), "width")),
  );
  assert.ok(
    Number(Reflect.get(Object(queue), "width")) >=
      Number(Reflect.get(Object(loop), "width")),
  );
  assert.ok(
    Number(Reflect.get(Object(queue), "height")) <
      Number(Reflect.get(Object(loop), "height")),
  );
}
