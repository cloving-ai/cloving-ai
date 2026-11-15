import assert from "node:assert/strict";
import { test } from "node:test";
import { floorModel } from "./watch-floor-fixture.ts";
import { watchPageServer } from "./watch-page-server.ts";
import { realBrowser } from "./watch-real-browser.ts";

await test("CLV-377 compact queue meters and collapsed tuning reflow at phone and desktop widths", async () => {
  const queue = {
    workflowId: "develop-issue",
    state: "running",
    lanes: 2,
    busy: 3,
    settings: { workingLanes: { value: 1, source: "default" } },
  };
  await using browser = await realBrowser();
  for (const width of [390, 1600]) {
    await using fixture = await watchPageServer(
      { ...floorModel([]), queues: [queue] },
      { token: "a".repeat(64) },
    );
    const page = await browser.page({ width, height: 844 });
    await page.navigate(fixture.url);
    const result = await page.evaluate(`(async () => {
      for (let i=0; i<300 && !document.querySelector(".line-queue"); i++) await new Promise(requestAnimationFrame);
      const card=document.querySelector(".line-queue");
      const buttons=[...card.querySelector(".queue-row:nth-of-type(2)").querySelectorAll(":scope > .queue-stepper > button")];
      const meter=card.querySelector(".queue-meter");
      return { busy:meter.querySelectorAll(".busy").length, label:meter.getAttribute("aria-label"), height:getComputedStyle(meter).height,
        open:card.querySelector(".queue-more").open, warning:card.querySelector(".queue-warning").textContent,
        boxes:buttons.map(node => {const b=node.getBoundingClientRect(); return {left:b.left,right:b.right,width:b.width,height:b.height};}),
        inside:buttons.length===2 && buttons.every(node => {const b=node.getBoundingClientRect(); return b.left>=0 && b.right<=innerWidth && b.width>=24 && b.height>=24;}) };
    })()`);
    assert.equal(result["busy"], 3);
    assert.equal(result["label"], "3 of 2 lanes busy");
    assert.equal(result["height"], "7px");
    assert.equal(result["open"], false);
    assert.equal(result["warning"], "1 over limit · new starts wait");
    assert.equal(result["inside"], true, JSON.stringify({ width, result }));
  }
});

await test("CLV-377 board controls stay grouped and global content shares the Today inset", async () => {
  const queue = {
    workflowId: "develop-issue",
    state: "running",
    lanes: 4,
    busy: 1,
  };
  const globalQueue = {
    state: "running",
    lanes: 8,
    busy: 1,
    workingLanes: 8,
    eligible: true,
  };
  await using browser = await realBrowser();
  for (const width of [390, 1600]) {
    await using fixture = await watchPageServer(
      { ...floorModel([]), queues: [queue], globalQueue },
      { token: "a".repeat(64) },
    );
    const page = await browser.page({ width, height: 1000 });
    await page.navigate(fixture.url + "#workflow=develop-issue");
    const board = await page.evaluate(`(async () => {
      for(let i=0;i<300&&!document.querySelector('.board-page .line-queue');i++) await new Promise(requestAnimationFrame);
      const card=document.querySelector('.board-page .line-queue');
      const box=card.getBoundingClientRect();
      return {width:box.width,left:box.left,right:box.right,meter:getComputedStyle(card.querySelector('.queue-meter')).height,
        heading:[...document.querySelectorAll('h2')].filter(n=>n.textContent==='develop-issue' && n.getBoundingClientRect().height>10).length,
        controls:[...card.querySelectorAll('.queue-row:nth-of-type(2) > *')].map(n=>n.getBoundingClientRect().width)};
    })()`);
    assert.ok(Number(board["width"]) <= 360, JSON.stringify(board));
    assert.ok(Number(board["left"]) >= 0 && Number(board["right"]) <= width);
    assert.equal(board["heading"], 1);
    assert.equal(board["meter"], "7px");
    await page.navigate(fixture.url);
    const inset = await page.evaluate(`(async () => {
      for(let i=0;i<300&&!document.querySelector('.global-queue');i++) await new Promise(requestAnimationFrame);
      const global=document.querySelector('.global-queue');
      return {padding:getComputedStyle(global).paddingLeft,meter:getComputedStyle(global.querySelector('.queue-meter')).height};
    })()`);
    assert.equal(inset["padding"], "20px");
    assert.equal(inset["meter"], "7px");
  }
});
