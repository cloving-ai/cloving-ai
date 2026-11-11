import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { floorModel, floorRun } from "./watch-floor-fixture.ts";
import { watchPageServer } from "./watch-page-server.ts";
import { realBrowser } from "./watch-real-browser.ts";

function labelled(
  run: Record<string, unknown>,
  label: string,
): Record<string, unknown> {
  const status = run["status"];
  return {
    ...run,
    status: {
      ...(typeof status === "object" ? status : {}),
      label,
      labelSource: "manual",
    },
  };
}

function model(first: string) {
  return floorModel([
    labelled(
      floorRun("run-a", { operation: "claude-turn", minutes: 5 }),
      first,
    ),
    labelled(
      floorRun("run-b", { operation: "claude-turn", minutes: 9 }),
      "#726 with a much longer label",
    ),
    labelled(
      floorRun("run-m", { operation: "github-merge", minutes: 20 }),
      "#725 with a label that is wider than the merge column",
    ),
  ]);
}

const ready = `(async () => {
  const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  for (let attempt = 0; attempt < 300 && document.querySelectorAll(".tokens .token-menu").length < 3; attempt++) await frame();
  return { menus: document.querySelectorAll(".tokens .token-menu").length };
})()`;

const layout = `(() => {
  const box = (node) => node.getBoundingClientRect();
  const station = [...document.querySelectorAll(".station")].find((item) => item.querySelectorAll(".tokens li").length === 2);
  const items = [...station.querySelectorAll(".tokens li")];
  const merge = document.querySelector('.token-menu-open[popovertarget="token-menu-run-m"]').closest(".station");
  const card = merge.querySelector(".token");
  return {
    rows: items.map((item) => Math.round(box(item).height - box(item.querySelector(".token")).height)),
    gap: Math.round(box(items[1]).top - box(items[0]).bottom),
    inside: items.map((item) => box(item.querySelector(".token-menu-open")).right <= box(item.querySelector(".token")).right + 0.5),
    clear: items.map((item) => {
      const range = document.createRange();
      range.selectNodeContents(item.querySelector(".token-time"));
      return box(item.querySelector(".token-menu-open")).left >= range.getBoundingClientRect().right;
    }),
    fits: box(card).right <= box(merge).right + 0.5 && card.scrollWidth >= card.clientWidth,
  };
})()`;

const opened = `(() => {
  const pops = [...document.querySelectorAll(".token-pop")];
  return { open: pops.filter((pop) => pop.matches(":popover-open")).map((pop) => pop.id).join(",") };
})()`;

const center = (selector: string) => `(() => {
  const box = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
})()`;

const placed = `(() => {
  const open = document.querySelector('[popovertarget="token-menu-run-a"]').getBoundingClientRect();
  const pop = document.querySelector("#token-menu-run-a").getBoundingClientRect();
  const next = document.querySelector('[popovertarget="token-menu-run-b"]').closest("li").getBoundingClientRect();
  return {
    below: pop.top >= open.bottom - 1 && pop.top <= open.bottom + 12,
    gap: { x: pop.left + 8, y: (open.bottom + pop.top) / 2 },
    inside: { x: pop.left + pop.width / 2, y: pop.top + pop.height / 2 },
    next: Math.round(next.top),
    font: getComputedStyle(document.querySelector("#token-menu-run-a button")).fontFamily === getComputedStyle(document.querySelector(".token")).fontFamily,
    list: (() => {
      const items = [...document.querySelectorAll("#token-menu-run-a button")].map((item) => item.getBoundingClientRect());
      const tops = items.map((item) => Math.round(item.top));
      return new Set(tops).size === items.length && new Set(items.map((item) => Math.round(item.left))).size === 1 && new Set(items.map((item) => Math.round(item.width))).size === 1;
    })(),
  };
})()`;

const point = (value: Record<string, unknown>) => ({
  x: Number(value["x"]),
  y: Number(value["y"]),
});

const waited = (expression: string, expected: unknown) => `(async () => {
  const want = ${JSON.stringify(JSON.stringify(expected))};
  const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  await document.fonts.ready;
  await frame();
  await frame();
  let value = null;
  for (let attempt = 0; attempt < 300; attempt++) {
    value = await (${expression});
    if (JSON.stringify(value) === want) break;
    await frame();
  }
  return { value };
})()`;

async function reached(
  page: {
    readonly evaluate: (expression: string) => Promise<Record<string, unknown>>;
  },
  check: {
    readonly name: string;
    readonly expression: string;
    readonly expected: unknown;
  },
): Promise<void> {
  const shown = (await page.evaluate(waited(check.expression, check.expected)))[
    "value"
  ];
  assert.deepEqual(
    shown,
    check.expected,
    `${check.name}: ${JSON.stringify(shown)}`,
  );
}

const placedParts = `(() => {
  const value = ${placed};
  return [value.below, value.next, value.font, value.list];
})()`;

await test("CLV-354 the token menu sits inside each card with no empty row, a card fits its column, and the popover opens on hover next to the menu button without moving the cards", async () => {
  await using fixture = await watchPageServer(model("#727"), {
    token: "a".repeat(64),
  });
  await using browser = await realBrowser();
  const page = await browser.page({ width: 1280, height: 844 });
  await page.navigate(fixture.url);
  await reached(page, {
    name: "menus",
    expression: ready,
    expected: { menus: 3 },
  });
  await reached(page, {
    name: "layout",
    expression: layout,
    expected: {
      rows: [0, 0],
      gap: 6,
      inside: [true, true],
      clear: [true, true],
      fits: true,
    },
  });
  const before = await page.evaluate(placed);
  await page.move(
    point(await page.evaluate(center('[popovertarget="token-menu-run-a"]'))),
  );
  await reached(page, {
    name: "hover open",
    expression: opened,
    expected: { open: "token-menu-run-a" },
  });
  await reached(page, {
    name: "placed",
    expression: placedParts,
    expected: [true, before["next"], true, true],
  });
  const shown = await page.evaluate(placed);
  await page.move(point(fields(shown["gap"])));
  await delay(100);
  await page.move(point(fields(shown["inside"])));
  await delay(400);
  assert.deepEqual(
    await page.evaluate(opened),
    { open: "token-menu-run-a" },
    "stays open in the popover",
  );
  await page.move({ x: 5, y: 830 });
  await reached(page, {
    name: "closed after leave",
    expression: opened,
    expected: { open: "" },
  });
});

function fields(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) return {};
  return Object.fromEntries(Object.entries(value));
}

await test("CLV-354 Escape, a click outside and the keyboard open and close the token menu", async () => {
  await using fixture = await watchPageServer(model("#727"), {
    token: "a".repeat(64),
  });
  await using browser = await realBrowser();
  const page = await browser.page({ width: 1280, height: 844 });
  await page.navigate(fixture.url);
  await page.evaluate(ready);
  const button = point(
    await page.evaluate(center('[popovertarget="token-menu-run-a"]')),
  );
  await page.move(button);
  await page.press({ key: "Escape", code: 27 });
  const escaped = await page.evaluate(opened);
  await page.move({ x: 5, y: 830 });
  await delay(400);
  await page.move(button);
  await page.click("h2#floor-title");
  const outside = await page.evaluate(opened);
  await page.evaluate(
    `(() => { document.querySelector('[popovertarget="token-menu-run-b"]').focus(); return {}; })()`,
  );
  const focused = await page.evaluate(opened);
  assert.deepEqual(
    [escaped, outside, focused],
    [{ open: "" }, { open: "" }, { open: "token-menu-run-b" }],
  );
});

await test("CLV-354 Rename in the token menu keeps the popover open while its input has the focus, and the card shows the saved name", async () => {
  await using fixture = await watchPageServer(model("#727"), {
    token: "a".repeat(64),
    actions: {
      "/actions/rename": {
        reply: { kind: "rename", runId: "run-a", title: "New title" },
        next: model("Renamed"),
      },
    },
  });
  await using browser = await realBrowser();
  const page = await browser.page({ width: 1280, height: 844 });
  await page.navigate(fixture.url);
  await page.evaluate(ready);
  await page.move(
    point(await page.evaluate(center('[popovertarget="token-menu-run-a"]'))),
  );
  await page.move(
    point(await page.evaluate(center("#token-menu-run-a .rename-open"))),
  );
  await page.click("#token-menu-run-a .rename-open");
  await page.move({ x: 5, y: 830 });
  await delay(400);
  const editing = await page.evaluate(opened);
  const buttons = await page.evaluate(`(() => {
    const [save, cancel] = [...document.querySelectorAll("#token-menu-run-a .rename-form button")].map((item) => item.getBoundingClientRect());
    return { row: Math.round(save.top) === Math.round(cancel.top), order: save.left < cancel.left };
  })()`);
  assert.deepEqual(buttons, { row: true, order: true });
  await page.evaluate(
    `(() => { const input = document.querySelector('#token-menu-run-a input[name="label"]'); input.select(); return {}; })()`,
  );
  await page.type("Renamed");
  await page.press({ key: "Enter", code: 13 });
  const saved = await page.evaluate(`(async () => {
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    const text = () => document.querySelector('[popovertarget="token-menu-run-a"]').closest("li").querySelector(".token").textContent;
    for (let attempt = 0; attempt < 300 && !text().includes("Renamed"); attempt++) await frame();
    return { text: text().includes("Renamed") };
  })()`);
  assert.deepEqual(
    [editing, saved],
    [{ open: "token-menu-run-a" }, { text: true }],
  );
});

const focusedPart = `(() => {
  const node = document.activeElement;
  return {
    name: node?.getAttribute("class") ?? null,
    run: node?.closest(".run-command")?.getAttribute("data-run") ?? node?.getAttribute("popovertarget") ?? null,
  };
})()`;

await test("CLV-354 Cancel of Rename in the second token menu puts the focus back on the Rename item of that token", async () => {
  await using fixture = await watchPageServer(model("#727"), {
    token: "a".repeat(64),
  });
  await using browser = await realBrowser();
  const page = await browser.page({ width: 1280, height: 844 });
  await page.navigate(fixture.url);
  await page.evaluate(ready);
  await page.move(
    point(await page.evaluate(center('[popovertarget="token-menu-run-a"]'))),
  );
  await page.move(
    point(await page.evaluate(center("#token-menu-run-a .rename-open"))),
  );
  await page.click("#token-menu-run-a .rename-open");
  await page.click('#token-menu-run-a .rename-form button[type="button"]');
  assert.deepEqual(
    [await page.evaluate(focusedPart), await page.evaluate(opened)],
    [{ name: "rename-open", run: "run-a" }, { open: "token-menu-run-a" }],
  );
});

await test("CLV-354 a keyboard user opens the token menu, starts Rename, and Escape closes the form and the menu with the focus back on the menu button", async () => {
  await using fixture = await watchPageServer(model("#727"), {
    token: "a".repeat(64),
  });
  await using browser = await realBrowser();
  const page = await browser.page({ width: 1280, height: 844 });
  await page.navigate(fixture.url);
  await page.evaluate(ready);
  await page.evaluate(
    `(() => { document.querySelector('[popovertarget="token-menu-run-a"]').focus(); return {}; })()`,
  );
  const menu = await page.evaluate(opened);
  await page.evaluate(
    `(() => { document.querySelector("#token-menu-run-a .rename-open").focus(); return {}; })()`,
  );
  await page.press({ key: "Enter", code: 13, text: "\r" });
  const form = await page.evaluate(`(async () => {
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    for (let attempt = 0; attempt < 120 && document.activeElement?.tagName !== "INPUT"; attempt++) await frame();
    return { input: document.activeElement?.getAttribute("name") ?? null };
  })()`);
  await page.press({ key: "Escape", code: 27 });
  const closed = await page.evaluate(`(async () => {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    return { forms: document.querySelectorAll(".rename-form").length };
  })()`);
  assert.deepEqual(
    [
      menu,
      form,
      closed,
      await page.evaluate(opened),
      await page.evaluate(focusedPart),
    ],
    [
      { open: "token-menu-run-a" },
      { input: "title" },
      { forms: 0 },
      { open: "" },
      { name: "token-menu-open", run: "token-menu-run-a" },
    ],
  );
});

await test("CLV-354 the token menu stays open under the pointer when the keyboard focus moves out of its last item, and closes when the pointer leaves", async () => {
  await using fixture = await watchPageServer(model("#727"), {
    token: "a".repeat(64),
  });
  await using browser = await realBrowser();
  const page = await browser.page({ width: 1280, height: 844 });
  await page.navigate(fixture.url);
  await page.evaluate(ready);
  await page.move(
    point(await page.evaluate(center('[popovertarget="token-menu-run-a"]'))),
  );
  await page.move(point(await page.evaluate(center("#token-menu-run-a"))));
  await page.evaluate(
    `(() => { document.querySelector("#token-menu-run-a .run-command-drop").focus(); return {}; })()`,
  );
  await page.pressTab();
  await delay(400);
  const left = await page.evaluate(`(() => ({
    inside: document.querySelector("#token-menu-run-a").contains(document.activeElement),
  }))()`);
  const kept = await page.evaluate(opened);
  await page.move({ x: 5, y: 830 });
  await delay(400);
  assert.deepEqual(
    [left, kept, await page.evaluate(opened)],
    [{ inside: false }, { open: "token-menu-run-a" }, { open: "" }],
  );
});
