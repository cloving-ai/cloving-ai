import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { boardLayout } from "../src/cli/watch-board-view.ts";
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

async function watchFixture(shown = overflowingBoard()) {
  const preact = await readFile(new URL(import.meta.resolve("preact")));
  const page = pageDocument().replace(/<link rel="stylesheet"[^>]*>/, "");
  const model = JSON.stringify(shown);
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

for (const width of [390, 1000])
  await test(`CLV-124 all refused workflows remain reachable beside the board at ${String(width)}px`, async () => {
    const shown = {
      ...overflowingBoard(),
      workflowRefusals: Array.from({ length: 80 }, (_, index) => ({
        scope: "user" as const,
        label: `refused-${String(index).padStart(2, "0")}.ts`,
        codes: ["invalid-declaration"],
      })),
    };
    await using fixture = await watchFixture(shown);
    await using browser = await realBrowser();
    const page = await browser.page({ width, height: 700 });
    await page.navigate(fixture.url);
    const result = await page.evaluate(`(async () => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (document.querySelector(".workflow-refusals")) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      const list = document.querySelector(".workflow-refusals");
      const last = list.querySelector("li:last-child");
      const visible = () => {
        const rect = last.getBoundingClientRect();
        const bounds = list.getBoundingClientRect();
        return rect.top >= bounds.top && rect.bottom <= Math.min(bounds.bottom, innerHeight);
      };
      const before = visible();
      list.scrollTop = list.scrollHeight;
      const board = document.querySelector(".board").getBoundingClientRect();
      return { before, after: visible(), scrollTop: list.scrollTop,
        boardVisible: board.top < innerHeight && board.bottom <= innerHeight && board.height > 0,
        count: list.querySelectorAll("li").length };
    })()`);
    assert.equal(result["count"], 80);
    assert.equal(result["before"], false);
    assert.equal(result["after"], true);
    assert.ok(Number(result["scrollTop"]) > 0);
    assert.equal(result["boardVisible"], true);
  });

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
  assert.equal(
    Number(horizontal["scrollLeft"]) > Number(horizontal["initialScrollLeft"]),
    viewport.width < 1385,
    "scroll gestures move the board sideways only when columns overflow",
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
  contentWidth: number,
) {
  const expected = boardLayout({
    contentWidth,
    openColumns: 6,
    collapsedColumns: 1,
  });
  assert.ok(Math.abs(Number(expanded["width"]) - expected.columnWidth) < 0.1);
  assert.ok(Number(expanded["scrollTop"]) > 0);
  assert.equal(expanded["lastVisible"], true, "last Done card is reachable");
  assert.equal(expanded["lastId"], "done-19");
  assert.equal(expanded["lastOnScreen"], true);
  assert.equal(expanded["headerVisible"], true);
  assert.ok(Number(expanded["implementScrollTop"]) > 0);
}

interface LayoutMeasurement {
  readonly contentWidth: number;
  readonly openWidths: readonly number[];
  readonly collapsedWidths: readonly number[];
  readonly fullWidth: boolean;
  readonly tabsAbove: boolean;
  readonly overflow: boolean;
  readonly allVisible: boolean;
}

function isWidths(value: unknown): value is readonly number[] {
  return (
    Array.isArray(value) &&
    value.every((width: unknown) => typeof width === "number")
  );
}

function isLayout(value: unknown): value is LayoutMeasurement {
  if (value === null || typeof value !== "object") return false;
  const layout = fields(value);
  return (
    typeof layout["contentWidth"] === "number" &&
    isWidths(layout["openWidths"]) &&
    isWidths(layout["collapsedWidths"]) &&
    typeof layout["fullWidth"] === "boolean" &&
    typeof layout["tabsAbove"] === "boolean" &&
    typeof layout["overflow"] === "boolean" &&
    typeof layout["allVisible"] === "boolean"
  );
}

function assertInitialLayout(initial: Record<string, unknown>, width: number) {
  const layout = initial["layout"];
  assert.ok(isLayout(layout), "Invalid browser layout");
  return assertLayout(layout, width);
}

function assertLayout(layout: LayoutMeasurement, width: number) {
  const { contentWidth } = layout;
  const expected = boardLayout({
    contentWidth,
    openColumns: 5,
    collapsedColumns: 2,
  });
  assert.equal(layout.openWidths.length, 5);
  for (const actual of layout.openWidths)
    assert.ok(Math.abs(actual - expected.columnWidth) < 0.1);
  assert.deepEqual(layout.collapsedWidths, [44, 44]);
  assert.equal(layout.fullWidth, true);
  assert.equal(layout.tabsAbove, true);
  assert.equal(layout.overflow, width < 1385);
  assert.equal(layout.allVisible, width === 1385);
  assert.equal(expected.columnWidth === 200, width < 1385);
  return contentWidth;
}

await test("browser layout rejects coercible numeric fields", () => {
  const layout = {
    contentWidth: 1353,
    openWidths: Array.from({ length: 5 }, () => 238.6),
    collapsedWidths: [44, 44],
    fullWidth: true,
    tabsAbove: true,
    overflow: false,
    allVisible: true,
  };
  assert.equal(assertInitialLayout({ layout }, 1385), 1353);
  for (const invalid of [
    { ...layout, contentWidth: "1353" },
    { ...layout, openWidths: layout.openWidths.map(String) },
    { ...layout, openWidths: {} },
    { ...layout, collapsedWidths: ["44", "44"] },
    { ...layout, fullWidth: "true" },
    { ...layout, tabsAbove: "true" },
    { ...layout, overflow: 0 },
    { ...layout, allVisible: 1 },
    {},
    null,
    "layout",
  ])
    assert.throws(
      () => assertInitialLayout({ layout: invalid }, 1385),
      /Invalid browser layout/,
    );
});

for (const viewport of [
  { width: 1385, height: 989 },
  { width: 1000, height: 989 },
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
    const contentWidth = assertInitialLayout(initial, viewport.width);
    const tabs = await page.evaluate("watchScrolling.tabs()");
    assert.equal(tabs["overflow"], viewport.width === 390);
    assert.equal(tabs["boardBefore"], tabs["boardAfter"]);
    assert.equal(Number(tabs["scrollLeft"]) > 0, viewport.width === 390);
    await page.scroll("watchScrolling.activeGesture()");
    const scrolled = await page.evaluate("watchScrolling.scrolled()");
    assertColumnScroll(initial, scrolled);
    await page.evaluate("watchScrolling.rewind()");
    await page.scroll("watchScrolling.sidewaysGesture()");
    const horizontal = await page.evaluate("watchScrolling.horizontal()");
    assertHorizontal(horizontal, viewport);
    await page.evaluate("watchScrolling.expand()");
    await page.scroll("watchScrolling.sidewaysGesture()");
    await page.scroll("watchScrolling.doneGesture()");
    const expanded = await page.evaluate("watchScrolling.expanded()");
    assertExpanded(expanded, contentWidth);
    await page.evaluate("watchScrolling.showActive()");
    await page.scroll("watchScrolling.activeGesture()");
    const activeAgain = await page.evaluate("watchScrolling.scrolled()");
    assert.equal(activeAgain["lastVisible"], true);
    assert.equal(activeAgain["lastClickable"], true);
    assert.equal(activeAgain["lastId"], scrolled["lastId"]);
    await page.scroll("watchScrolling.returnGesture()");
    const final = await page.evaluate("watchScrolling.final()");
    assert.equal(final["returned"], 0);
    assert.deepEqual(final["pageScroll"], { x: 0, y: 0 });
    assert.deepEqual(final["page"], viewport);
  });
}
