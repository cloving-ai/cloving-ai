import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { pageDocument } from "../src/cli/watch-page.ts";
import { boardEvent, boardModel, boardRun } from "./watch-board-fixture.ts";
import { realBrowser } from "./watch-real-browser.ts";
import { scrollScenario } from "./watch-scroll-scenario.ts";

function overflowingBoard() {
  const active = Array.from({ length: 28 }, (_, index) =>
    boardRun(`implement-${String(index).padStart(2, "0")}`, {
      events: [boardEvent("claude-turn")],
    }),
  );
  const done = Array.from({ length: 20 }, (_, index) =>
    boardRun(`done-${String(index).padStart(2, "0")}`, {
      state: "completed",
      outcome: "handoff_requested",
    }),
  );
  return boardModel([...active, ...done]);
}

async function watchFixture() {
  const preact = await readFile(new URL(import.meta.resolve("preact")));
  const page = pageDocument().replace(/<link rel="stylesheet"[^>]*>/, "");
  const model = JSON.stringify(overflowingBoard());
  const server = createServer((request, response) => {
    if (request.url === "/preact.mjs") {
      response
        .writeHead(200, { "content-type": "text/javascript" })
        .end(preact);
      return;
    }
    if (request.url === "/data.json") {
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(model);
      return;
    }
    if (request.url === "/events") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: ready\n\n");
      return;
    }
    response
      .writeHead(200, {
        "content-type": "text/html",
        "content-security-policy": "default-src 'self' 'unsafe-inline' data:",
      })
      .end(page);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  return {
    async [Symbol.asyncDispose]() {
      server.closeAllConnections();
      await server[Symbol.asyncDispose]();
    },
    url: `http://127.0.0.1:${String(address.port)}/#workflow=develop-issue`,
  };
}

function fields(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object");
  return { ...value };
}

function assertColumnScroll(
  initial: Record<string, unknown>,
  scrolled: Record<string, unknown>,
) {
  const before = fields(initial["before"]);
  assert.equal(before["lastVisible"], false);
  assert.equal(before["scrollTop"], 0);
  assert.equal(scrolled["overflow"], true);
  assert.ok(
    Number(scrolled["scrollTop"]) > 0,
    "scroll gestures move the card list",
  );
  assert.equal(
    scrolled["lastVisible"],
    true,
    "last Claude turn card is reachable",
  );
  assert.equal(scrolled["lastId"], "implement-27");
  assert.equal(scrolled["lastOnScreen"], true);
  assert.equal(scrolled["lastClickable"], true);
  assert.deepEqual(
    scrolled["header"],
    before["header"],
    "header stays fixed while cards scroll",
  );
  assert.equal(scrolled["boardScrollTop"], 0);
}

function assertHorizontal(
  horizontal: Record<string, unknown>,
  viewport: { readonly width: number; readonly height: number },
) {
  assert.ok(
    Number(horizontal["scrollLeft"]) > Number(horizontal["initialScrollLeft"]),
    "scroll gestures move the board sideways",
  );
  assert.equal(horizontal["doneVisible"], true);
  assert.ok(
    Number(horizontal["scrollbar"]) >= 12,
    "horizontal scrollbar has visible space",
  );
  assert.equal(fields(horizontal["board"])["bottom"], viewport.height);
}

function assertExpanded(
  expanded: Record<string, unknown>,
  scrolled: Record<string, unknown>,
) {
  assert.equal(expanded["width"], 260);
  assert.ok(Number(expanded["scrollTop"]) > 0);
  assert.equal(expanded["lastVisible"], true, "last Done card is reachable");
  assert.equal(expanded["lastId"], "done-19");
  assert.equal(expanded["lastOnScreen"], true);
  assert.equal(expanded["headerVisible"], true);
  assert.equal(expanded["implementScrollTop"], scrolled["scrollTop"]);
}

for (const viewport of [
  { width: 1385, height: 989 },
  { width: 390, height: 844 },
]) {
  await test(`CLV-134 real browser reaches overflowing cards and keeps headers and board scrolling visible at ${String(viewport.width)}px`, async () => {
    await using fixture = await watchFixture();
    await using browser = await realBrowser();
    const page = await browser.page(viewport);
    await page.navigate(fixture.url);
    const initial = await page.evaluate(scrollScenario);
    assert.deepEqual(initial["viewport"], viewport);
    assert.equal(initial["initiallyCollapsed"], true);
    await page.scroll("watchScrolling.activeGesture()");
    const scrolled = await page.evaluate("watchScrolling.scrolled()");
    assertColumnScroll(initial, scrolled);
    await page.scroll("watchScrolling.sidewaysGesture()");
    const horizontal = await page.evaluate("watchScrolling.horizontal()");
    assertHorizontal(horizontal, viewport);
    await page.evaluate("watchScrolling.expand()");
    await page.scroll("watchScrolling.sidewaysGesture()");
    await page.scroll("watchScrolling.doneGesture()");
    const expanded = await page.evaluate("watchScrolling.expanded()");
    assertExpanded(expanded, scrolled);
    await page.scroll("watchScrolling.returnGesture()");
    const final = await page.evaluate("watchScrolling.final()");
    assert.equal(final["returned"], 0);
    assert.deepEqual(final["pageScroll"], { x: 0, y: 0 });
    assert.deepEqual(final["page"], viewport);
  });
}
