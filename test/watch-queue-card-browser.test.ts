import assert from "node:assert/strict";
import { test } from "node:test";
import { loopModel } from "./watch-loops-fixture.ts";
import { watchFontFiles, watchPageServer } from "./watch-page-server.ts";
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
  await using fixture = await watchPageServer(model, {
    token: "a".repeat(64),
    files: await watchFontFiles(),
  });
  await using browser = await realBrowser();
  const page = await browser.page({ width: 1600, height: 1000 });
  await page.navigate(fixture.url);
  const result = await page.evaluate(`(async () => {
    for (let frame = 0; frame < 300 && !document.querySelector(".line-queue"); frame++)
      await new Promise(requestAnimationFrame);
    await document.fonts.ready;
    const queue = document.querySelector(".line-queue");
    const loop = document.querySelector(".line-loop");
    if (!queue || !loop) return { missing: true };
    const box = (node) => { const rect = node.getBoundingClientRect(); return { left: rect.left, width: rect.width, height: rect.height }; };
    const probe = document.body.appendChild(document.createElement("div"));
    probe.style.alignItems = "flex-end";
    const endAlignment = getComputedStyle(probe).alignItems;
    probe.remove();
    return {
      endAlignment,
      fontsReady: document.fonts.check('400 14px "Space Grotesk"') && document.fonts.check('700 14px "Space Grotesk"'),
      fonts: [...document.fonts].map(face => ({ family: face.family, weight: face.weight, status: face.status })),
      rows: [...queue.querySelectorAll(':scope > .queue-row')].map(box),
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
  assert.equal(result["fontsReady"], true, JSON.stringify(result));
  assertAlignedBoxes(result);
  assertEndColumns(result);
  assert.equal(result["lanes"], 6);
  assert.equal(result["on"], "Drain");
});

function assertEndColumns(result: Readonly<Record<string, unknown>>) {
  const endAlignment = String(result["endAlignment"]);
  assert.match(endAlignment, /end$/);
  assert.deepEqual(result["shape"], [
    ["flex", "column", endAlignment],
    ["flex", "column", endAlignment],
  ]);
}

function assertAlignedBoxes(result: Readonly<Record<string, unknown>>) {
  const queue = result["queue"];
  const loop = result["loop"];
  assert.equal(
    Number(Reflect.get(Object(queue), "left")) +
      Number(Reflect.get(Object(queue), "width")),
    Number(Reflect.get(Object(loop), "left")) +
      Number(Reflect.get(Object(loop), "width")),
    JSON.stringify(result),
  );
  assert.ok(
    Number(Reflect.get(Object(queue), "width")) >=
      Number(Reflect.get(Object(loop), "width")),
    JSON.stringify(result),
  );
  assert.ok(
    Number(Reflect.get(Object(queue), "height")) <
      Number(Reflect.get(Object(loop), "height")),
    JSON.stringify(result),
  );
}

await test("CLV-377 a saved reset exposes a keyboard-operable same-request retry on a narrow page", async () => {
  const model = {
    ...loopModel(),
    globalQueue: {
      state: "running",
      eligible: true,
      lanes: 4,
      workingLanes: 4,
      configuredLanes: 4,
      busy: 1,
      sources: { lanes: "queue setting (private file)" },
    },
  };
  const reply = {
    error: {
      code: "queue-setting-failed",
      detail:
        "The setting was saved but not applied. Fix the workflow and retry this request.",
      saved: true,
    },
  };
  await using fixture = await watchPageServer(model, {
    token: "a".repeat(64),
    files: await watchFontFiles(),
    actions: { "/actions/queue-settings": { reply, next: model } },
  });
  await using browser = await realBrowser();
  const page = await browser.page({ width: 390, height: 844 });
  await page.navigate(fixture.url);
  await page.evaluate(`(async () => {
    for (let frame = 0; frame < 600 && !document.querySelector('.global-queue'); frame++) await new Promise(requestAnimationFrame);
    const plain = globalThis.fetch; globalThis.queuePosts = [];
    globalThis.fetch = (address, options) => { if (options?.method === "POST") queuePosts.push(JSON.parse(options.body)); return plain(address, options); };
    return {};
  })()`);
  await page.click(".global-queue .queue-more summary");
  await page.evaluate(`(() => {
    [...document.querySelectorAll('.global-queue button')].find(node => node.textContent === 'Use inherited lanes').focus(); return {};
  })()`);
  await page.press({ key: "Enter", code: 13, text: "\r" });
  const failed = await resetRetryShown(page);
  assert.match(String(failed["text"]), /saved but not applied/);
  assert.equal(failed["retry"], true);
  assert.equal(failed["lanes"], "4");
  assert.equal(failed["inside"], true);
  await page.press({ key: "Enter", code: 13, text: "\r" });
  const retried = await resetRetryShown(page);
  const posts = retried["posts"];
  assert.ok(Array.isArray(posts));
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[0], posts[1]);
  assert.match(String(retried["text"]), /saved but not applied/);
  assert.doesNotMatch(String(retried["text"]), /✓ Saved/);
});

async function resetRetryShown(
  page: Awaited<ReturnType<Awaited<ReturnType<typeof realBrowser>>["page"]>>,
) {
  return page.evaluate(`(async () => {
    const retry = () => [...document.querySelectorAll('.global-queue .queue-message button')].find(node => node.textContent === 'Retry same request');
    for (let frame = 0; frame < 600 && (!retry() || retry().disabled); frame++) await new Promise(requestAnimationFrame);
    const button = retry();
    if (button) { button.scrollIntoView({block:'center'}); button.focus(); }
    const box = button?.getBoundingClientRect();
    const panel = document.querySelector('.global-queue');
    return { text: panel.textContent, lanes: panel.querySelector('[aria-label="Lanes limit"]').textContent,
      retry: !!button, inside: !!box && box.left >= 0 && box.right <= innerWidth && box.width >= 24 && box.height >= 24, posts: queuePosts };
  })()`);
}
