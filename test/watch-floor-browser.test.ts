import assert from "node:assert/strict";
import { test } from "node:test";
import { floorModel, floorRun } from "./watch-floor-fixture.ts";
import { watchPageServer } from "./watch-page-server.ts";
import { realBrowser } from "./watch-real-browser.ts";

const reach = `(async () => {
  const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  for (let attempt = 0; attempt < 300 && !document.querySelector(".token"); attempt++) await frame();
  const targets = [...document.querySelectorAll(".station, .token")];
  const reached = [];
  for (const target of targets) {
    target.scrollIntoView({ block: "center", inline: "center" });
    await frame();
    const { left, right, top, bottom } = target.getBoundingClientRect();
    const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
    reached.push({
      name: target.querySelector(".station-name, .token-ticket")?.textContent ?? "",
      inside: left >= 0 && right <= innerWidth && top >= 0 && bottom <= innerHeight,
      hit: target.contains(hit),
    });
  }
  const line = document.querySelector(".line");
  const parts = [".line-name", ".line-track", ".line-end"].map((name) => line.querySelector(name).getBoundingClientRect());
  const track = line.querySelector(".line-track");
  return {
    reached,
    pageWidth: document.documentElement.scrollWidth,
    stacked: parts[0].bottom <= parts[1].top && parts[1].bottom <= parts[2].top,
    sideways: track.scrollWidth > track.clientWidth,
  };
})()`;

await test("CLV-286 at a width of 390 px every station and every token is reachable", async () => {
  const model = floorModel([
    floorRun("work", { operation: "github-prepare", ticketId: "580" }),
    floorRun("turn-a", { operation: "claude-turn", ticketId: "581" }),
    floorRun("turn-b", { operation: "claude-turn", ticketId: "582" }),
    floorRun("merge", { operation: "github-merge", ticketId: "583" }),
    floorRun("draft", { workflowId: "idea", operation: "write-draft" }),
  ]);
  await using fixture = await watchPageServer(model);
  await using browser = await realBrowser();
  const page = await browser.page({ width: 390, height: 844 });
  await page.navigate(fixture.url);
  const result = await page.evaluate(reach);
  const reached = result["reached"];
  assert.ok(Array.isArray(reached));
  assert.equal(reached.length, 7 + 5);
  for (const target of reached) {
    assert.ok(typeof target === "object" && target !== null);
    assert.ok(
      Reflect.get(target, "inside") === true &&
        Reflect.get(target, "hit") === true,
      JSON.stringify(target),
    );
  }
  assert.equal(result["pageWidth"], 390);
  assert.equal(result["stacked"], true);
  assert.equal(result["sideways"], true);
});
