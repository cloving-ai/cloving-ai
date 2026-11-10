import assert from "node:assert/strict";
import { test } from "node:test";
import { watchPageServer } from "./watch-page-server.ts";
import { realBrowser } from "./watch-real-browser.ts";
import { sampleModel, sampleRun } from "./watch-sample.ts";

const longRun = sampleModel([
  sampleRun({
    ciReruns: Array.from({ length: 80 }, (_, index) => ({
      run: String(9000 + index),
      commit: "9e69feb0123456789",
      requestedAt: 0,
    })),
  }),
]);

const ready = `(async () => {
  const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  for (let attempt = 0; attempt < 300 && !document.querySelector(".banner-back"); attempt++) await frame();
  return {};
})()`;

const scrolledToEnd = `(async () => {
  const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  scrollTo(0, document.documentElement.scrollHeight);
  await frame();
  await frame();
  const link = document.querySelector(".banner-back");
  const box = link.getBoundingClientRect();
  const center = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
  return {
    text: link.textContent,
    href: link.getAttribute("href"),
    scrolled: scrollY > 0,
    atEnd: Math.ceil(scrollY + innerHeight) >= document.documentElement.scrollHeight,
    inside: box.top >= 0 && box.left >= 0 && box.bottom <= innerHeight && box.right <= innerWidth && box.width > 0,
    onTop: center !== null && center.closest(".banner-back") === link,
  };
})()`;

const focused = `(() => {
  const node = document.activeElement;
  const style = getComputedStyle(node);
  return {
    name: node.getAttribute("class"),
    visible: node.matches(":focus-visible"),
    outline: style.outlineStyle + " " + style.outlineWidth,
  };
})()`;

const narrow = `(() => {
  const root = document.documentElement;
  const link = document.querySelector(".banner-back").getBoundingClientRect();
  const name = document.querySelector(".banner .name").getBoundingClientRect();
  const apart = link.right <= name.left || link.left >= name.right || link.bottom <= name.top || link.top >= name.bottom;
  return {
    sideways: root.scrollWidth - root.clientWidth,
    apart,
    inside: link.left >= 0 && link.right <= innerWidth,
  };
})()`;

for (const [hash, text, href] of [
  ["#run=run-1", "← Floor", "#"],
  [
    "#workflow=develop-ticket&run=run-1",
    "← develop-ticket",
    "#workflow=develop-ticket",
  ],
] as const)
  await test(`CLV-342 the back link in the run banner stays in the window and on top at the end of a long run page (${hash})`, async () => {
    await using fixture = await watchPageServer(longRun, { hash });
    await using browser = await realBrowser();
    const page = await browser.page({ width: 1280, height: 600 });
    await page.navigate(fixture.url);
    await page.evaluate(ready);
    assert.deepEqual(await page.evaluate(scrolledToEnd), {
      text,
      href,
      scrolled: true,
      atEnd: true,
      inside: true,
      onTop: true,
    });
  });

await test("CLV-342 the keyboard reaches the back link in the run banner with Tab, and the link shows the focus ring of the page", async () => {
  await using fixture = await watchPageServer(longRun, { hash: "#run=run-1" });
  await using browser = await realBrowser();
  const page = await browser.page({ width: 1280, height: 600 });
  await page.navigate(fixture.url);
  await page.evaluate(ready);
  const reached: unknown[] = [];
  for (let press = 0; press < 5; press += 1) {
    await page.pressTab();
    const shown = await page.evaluate(focused);
    reached.push(shown["name"]);
    if (shown["name"] !== "banner-back") continue;
    assert.deepEqual(shown, {
      name: "banner-back",
      visible: true,
      outline: "solid 3px",
    });
    return;
  }
  assert.fail(`Tab did not reach the back link: ${JSON.stringify(reached)}`);
});

for (const hash of [
  "#run=run-1",
  "#workflow=develop-ticket-with-a-long-workflow-name&run=run-1",
])
  await test(`CLV-342 at 390 px the run page has no horizontal scroll, and the back link does not cover the run name (${hash})`, async () => {
    await using fixture = await watchPageServer(longRun, { hash });
    await using browser = await realBrowser();
    const page = await browser.page({ width: 390, height: 844 });
    await page.navigate(fixture.url);
    await page.evaluate(ready);
    assert.deepEqual(await page.evaluate(narrow), {
      sideways: 0,
      apart: true,
      inside: true,
    });
  });
