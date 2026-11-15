import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { watching } from "./watch-fixture.ts";
import { realBrowser } from "./watch-real-browser.ts";
import { call } from "./service-fixture.ts";
import { testMilliseconds } from "./test-timing.ts";
import { field, type Scene } from "./self-host-fixture.ts";
import { laneReloadDiagnostics } from "./queue-lane-reload-fixture.ts";

type BrowserPage = Awaited<
  ReturnType<Awaited<ReturnType<typeof realBrowser>>["page"]>
>;
interface BrowserContext {
  readonly page: BrowserPage;
  readonly fixture: Scene;
}

const observeApply = `
if (!globalThis.queueApplyProbe) {
  const probe = globalThis.queueApplyProbe = { acknowledgements: {}, posts: [] };
  const observe = () => {
    for (const selector of ['.global-queue', '.board-page .line-queue']) {
      const text = document.querySelector(selector)?.textContent ?? '';
      if (text.includes('✓ Saved')) probe.acknowledgements[selector] = text;
    }
  };
  new MutationObserver(observe).observe(document.body, {subtree:true, childList:true, characterData:true});
  const plain = globalThis.fetch;
  globalThis.fetch = async (address, options) => {
    if (address !== 'actions/queue-settings' || options?.method !== 'POST') return plain(address, options);
    const post = { command: JSON.parse(options.body), at: performance.now() };
    probe.posts.push(post);
    const response = await plain(address, options);
    post.status = response.status;
    const body = await response.clone().text();
    try { post.reply = JSON.parse(body); }
    catch { post.reply = body; }
    if (probe.posts.length === 1 && response.ok) {
      post.lostReply = true;
      return new Response('lost reply', {status:503});
    }
    return response;
  };
}
`;

const diagnostics = `(() => ({
  url: location.href, focus: {tag:document.activeElement?.tagName, label:document.activeElement?.getAttribute('aria-label')},
  probe: globalThis.queueApplyProbe ?? null,
  text: document.querySelector('.global-queue')?.textContent,
  board: document.querySelector('.board-page .line-queue')?.textContent,
  buttons: [...document.querySelectorAll('.queue-lane-button')].map(node => ({label: node.getAttribute('aria-label'), disabled: node.disabled}))
}))()`;

interface BrowserCheck {
  readonly phase: string;
  readonly script: string;
}

async function queueWait(
  context: BrowserContext,
  check: BrowserCheck,
): Promise<Record<string, unknown>> {
  const end = Date.now() + testMilliseconds(10_000);
  let shown: Record<string, unknown> = {};
  try {
    do {
      shown = await context.page.evaluate(check.script);
      if (shown["ready"] === true) return shown;
      await delay(20);
    } while (Date.now() < end);
    throw new Error("The queue browser predicate was not reached.");
  } catch (error) {
    const page = await context.page.evaluate(diagnostics).catch(String);
    const daemon = await call(context.fixture, {
      operation: "status",
      parameters: {},
    }).catch(String);
    throw new Error(
      `Queue browser ${check.phase}: ${JSON.stringify({ shown, page, daemon })}`,
      { cause: error },
    );
  }
}

async function queueApplied(context: BrowserContext, check: BrowserCheck) {
  const shown = await queueWait(context, check);
  if (shown["acknowledged"] !== undefined) return shown;
  const first = await context.page.evaluate(
    `(() => ({commands:queueApplyProbe.posts.map(post => post.command)}))()`,
  );
  await context.page.evaluate(`(() => {
    const button = [...document.querySelectorAll('.queue-message button')].find(node => node.textContent === 'Retry same request' && !node.disabled);
    button.focus(); return {focused:document.activeElement === button};
  })()`);
  await context.page.press({ key: "Enter", code: 13, text: "\r" });
  const retried = await queueWait(context, check);
  const last = await context.page.evaluate(
    `(() => ({commands:queueApplyProbe.posts.map(post => post.command)}))()`,
  );
  const before = first["commands"];
  const after = last["commands"];
  assert.ok(Array.isArray(before) && Array.isArray(after));
  assert.equal(after.length, before.length + 1);
  assert.deepEqual(after.at(-1), before.at(-1));
  assert.match(
    String(retried["acknowledged"]),
    /Saved/,
    JSON.stringify(await context.page.evaluate(diagnostics)),
  );
  return retried;
}

export async function checkedLiveBrowser(fixture: Scene) {
  const watch = await watching(fixture.runtimeDirectory, {
    directory: fixture.repository,
  });
  try {
    await using browser = await realBrowser();
    const page = await browser.page({ width: 390, height: 844 });
    const context = { page, fixture };
    await page.navigate(watch.address);
    await queueWait(context, {
      phase: "global button and focus",
      script: `(() => {
        const button = document.querySelector('[aria-label="More lanes for Global queue"]');
        if (!button || button.disabled) return {ready:false};
        ${observeApply}
        button.focus(); return {ready:document.activeElement === button};
      })()`,
    });
    await page.press({ key: "Enter", code: 13, text: "\r" });
    const shown = await queueApplied(context, {
      phase: "global apply acknowledgement and readback",
      script: `(() => {
        const panel = document.querySelector('.global-queue');
        const meter = panel.querySelector('.queue-meter');
        const buttons = [...panel.querySelectorAll(':scope > .queue-stepper > .queue-lane-button')];
        const acknowledged = globalThis.queueApplyProbe.acknowledgements['.global-queue'];
        const retry = [...panel.querySelectorAll('.queue-message button')].some(node => node.textContent === 'Retry same request' && !node.disabled);
        return { ready:!!acknowledged || retry, acknowledged, text:panel.textContent, meter:getComputedStyle(meter).height, filled:meter.querySelectorAll('.busy').length,
          sidebar: !!panel.closest('.side-panels'), inHeader: !!panel.closest('header'),
          inside: buttons.length===2 && buttons.every(node => { const box=node.getBoundingClientRect(); return box.left>=0 && box.right<=innerWidth && box.width>=24; }) };
      })()`,
    });
    assert.match(
      String(shown["text"]),
      /Global queue running, 2 of 2 global lanes busy/,
    );
    assert.match(String(shown["acknowledged"]), /Saved/);
    assert.equal(shown["meter"], "7px");
    assert.equal(shown["filled"], 2);
    assert.equal(shown["sidebar"], true);
    assert.equal(shown["inHeader"], false);
    assert.equal(shown["inside"], true);
    const daemon = await call(fixture, { operation: "status", parameters: {} });
    assert.equal(field(daemon["globalQueue"], "lanes"), 2);
    await checkedWorkflowBrowser(context, watch.address);
  } catch (error) {
    const saved = await laneReloadDiagnostics(fixture);
    const daemon = await call(fixture, {
      operation: "status",
      parameters: {},
    }).catch(String);
    throw new Error(
      JSON.stringify({ saved, daemon, watch: watch.output?.text }),
      { cause: error },
    );
  } finally {
    assert.equal(await watch.stop(), 0);
  }
}

async function checkedWorkflowBrowser(
  context: BrowserContext,
  address: string,
) {
  const { page } = context;
  await page.navigate(`${address}#workflow=lane-turn`);
  await queueWait(context, {
    phase: "workflow button and focus",
    script: `(() => {
      const button = document.querySelector('.board-page [aria-label="More lanes for lane-turn"]');
      if (!button || button.disabled) return {ready:false};
      ${observeApply}
      button.focus(); return {ready:document.activeElement === button};
    })()`,
  });
  await page.press({ key: "Enter", code: 13, text: "\r" });
  const shown = await queueApplied(context, {
    phase: "workflow apply acknowledgement and readback",
    script: `(() => {
      const card=document.querySelector('.board-page .line-queue');
      const acknowledged=globalThis.queueApplyProbe.acknowledgements['.board-page .line-queue'];
      const retry = [...card.querySelectorAll('.queue-message button')].some(node => node.textContent === 'Retry same request' && !node.disabled);
      return {ready:!!acknowledged || retry, acknowledged, text:card.textContent, lanes:card.querySelector('[aria-label="Lanes limit"]').textContent,
        open:card.querySelector('.queue-more').open, meter:getComputedStyle(card.querySelector('.queue-meter')).height,
        busy:card.querySelectorAll('.lane.busy').length, free:card.querySelectorAll('.lane.free').length };
    })()`,
  });
  assert.match(String(shown["acknowledged"]), /Saved/);
  assert.equal(shown["lanes"], "4");
  assert.equal(shown["open"], false);
  assert.equal(shown["meter"], "7px");
  assert.equal(shown["busy"], 2);
  assert.equal(shown["free"], 2);
  const daemon = await call(context.fixture, {
    operation: "status",
    parameters: {},
  });
  const queues = daemon["queues"];
  assert.ok(Array.isArray(queues));
  assert.equal(
    field(
      queues.find((queue) => field(queue, "workflowId") === "lane-turn"),
      "lanes",
    ),
    4,
  );
}
