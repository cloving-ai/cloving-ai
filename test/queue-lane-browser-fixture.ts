import assert from "node:assert/strict";
import { watching } from "./watch-fixture.ts";
import { realBrowser } from "./watch-real-browser.ts";
import type { Scene } from "./self-host-fixture.ts";

type BrowserPage = Awaited<
  ReturnType<Awaited<ReturnType<typeof realBrowser>>["page"]>
>;

export async function checkedLiveBrowser(fixture: Scene) {
  const watch = await watching(fixture.runtimeDirectory, {
    directory: fixture.repository,
  });
  try {
    await using browser = await realBrowser();
    const page = await browser.page({ width: 390, height: 844 });
    await page.navigate(watch.address);
    await page.evaluate(`(async () => {
      for (let i = 0; i < 600 && !document.querySelector('.global-queue .queue-lane-button'); i++) await new Promise(requestAnimationFrame);
      document.querySelector('[aria-label="More lanes for Global queue"]').focus(); return {};
    })()`);
    await page.press({ key: "Enter", code: 13, text: "\r" });
    const shown = await page.evaluate(`(async () => {
      for (let i = 0; i < 1200 && !document.querySelector('.global-queue')?.textContent.includes('Saved'); i++) await new Promise(requestAnimationFrame);
      const panel = document.querySelector('.global-queue');
      const meter = panel.querySelector('.queue-meter');
      const buttons = [...panel.querySelectorAll(':scope > .queue-stepper > .queue-lane-button')];
      return { text:panel.textContent, meter:getComputedStyle(meter).height, filled:meter.querySelectorAll('.busy').length,
        sidebar: !!panel.closest('.side-panels'), inHeader: !!panel.closest('header'),
        inside: buttons.length===2 && buttons.every(node => { const box=node.getBoundingClientRect(); return box.left>=0 && box.right<=innerWidth && box.width>=24; }) };
    })()`);
    assert.match(
      String(shown["text"]),
      /Global queue running, 2 of 2 global lanes busy/,
    );
    assert.match(String(shown["text"]), /Saved/);
    assert.equal(shown["meter"], "7px");
    assert.equal(shown["filled"], 2);
    assert.equal(shown["sidebar"], true);
    assert.equal(shown["inHeader"], false);
    assert.equal(shown["inside"], true);
    await checkedWorkflowBrowser(page, watch.address);
  } finally {
    assert.equal(await watch.stop(), 0);
  }
}

async function checkedWorkflowBrowser(page: BrowserPage, address: string) {
  await page.navigate(`${address}#workflow=lane-turn`);
  await page.evaluate(`(async () => {
    for (let i=0; i<600 && !document.querySelector('.board-page .line-queue'); i++) await new Promise(requestAnimationFrame);
    document.querySelector('[aria-label="More lanes for lane-turn"]').focus(); return {};
  })()`);
  await page.press({ key: "Enter", code: 13, text: "\r" });
  const shown = await page.evaluate(`(async () => {
    for (let i=0; i<1200 && !document.querySelector('.queue-counts')?.textContent.includes('Saved'); i++) await new Promise(requestAnimationFrame);
    const card=document.querySelector('.board-page .line-queue');
    return { text:card.textContent, lanes:card.querySelector('[aria-label="Lanes limit"]').textContent,
      open:card.querySelector('.queue-more').open, meter:getComputedStyle(card.querySelector('.queue-meter')).height,
      busy:card.querySelectorAll('.lane.busy').length, free:card.querySelectorAll('.lane.free').length };
  })()`);
  assert.match(String(shown["text"]), /Saved/);
  assert.equal(shown["lanes"], "4");
  assert.equal(shown["open"], false);
  assert.equal(shown["meter"], "7px");
  assert.equal(shown["busy"], 2);
  assert.equal(shown["free"], 2);
}
