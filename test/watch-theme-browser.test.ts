import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { WatchModel } from "../src/cli/watch-render.ts";
import { watchThemes, type WatchThemes } from "../src/cli/watch-themes.ts";
import { twoLineModel } from "./watch-floor-fixture.ts";
import { watchPageServer } from "./watch-page-server.ts";
import { realBrowser } from "./watch-real-browser.ts";
import { shelfModel } from "./watch-shelf-fixture.ts";
import { themeScene } from "./watch-theme-fixture.ts";

const bench = "/themes/workshop/assets/bench.svg";
const defaultRunning = "rgb(31, 157, 85)";
const plainRunning = "rgb(122, 31, 162)";

const measure = `(async () => {
  const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  for (let attempt = 0; attempt < 300 && !document.querySelector(".station .lamp, .shelf-count"); attempt++) await frame();
  await frame();
  const root = document.documentElement;
  const lamp = (selector) => {
    const node = document.querySelector(selector);
    if (node === null) return null;
    const own = getComputedStyle(node);
    const mark = getComputedStyle(node, "::after");
    return { color: own.backgroundColor, image: own.backgroundImage, width: own.width, mark: mark.content, markColor: mark.backgroundColor };
  };
  const brand = document.querySelector(".brand");
  const notice = document.querySelector(".theme-notice");
  const menu = document.querySelector(".theme-menu select");
  return {
    theme: root.getAttribute("data-theme"),
    classes: root.className,
    running: lamp(".station .lamp.running"),
    empty: lamp(".station .lamp.empty"),
    shelf: document.querySelector(".shelf-count")?.textContent ?? null,
    logo: { svg: brand.querySelector("svg").outerHTML, color: getComputedStyle(brand.querySelector("svg")).color, font: getComputedStyle(brand).fontFamily, size: getComputedStyle(brand).fontSize },
    notice: notice?.textContent ?? null,
    menu: menu?.value ?? null,
  };
})()`;

const chosen = (name: string) => `(async () => {
  const menu = document.querySelector(".theme-menu select");
  menu.value = ${JSON.stringify(name)};
  menu.dispatchEvent(new Event("change", { bubbles: true }));
  await new Promise((resolve) => requestAnimationFrame(resolve));
  return { theme: document.documentElement.getAttribute("data-theme"), color: getComputedStyle(document.querySelector(".station .lamp.running")).backgroundColor };
})()`;

async function sceneThemes(setting: string): Promise<{
  readonly themes: WatchThemes;
  readonly art: Uint8Array;
}> {
  await using folders = await themeScene();
  return {
    themes: await watchThemes({ setting, folders }),
    art: await readFile(join(folders.project, "workshop/assets/bench.svg")),
  };
}

async function shown(
  setting: string,
  model: WatchModel = twoLineModel(),
): Promise<Record<string, unknown>> {
  const { themes, art } = await sceneThemes(setting);
  await using fixture = await watchPageServer(model, {
    themes,
    files: { [bench]: { type: "image/svg+xml", body: art } },
  });
  await using browser = await realBrowser();
  const page = await browser.page({ width: 1280, height: 800 });
  await page.navigate(fixture.url);
  return await page.evaluate(measure);
}

function field(value: unknown, name: string): unknown {
  assert.ok(typeof value === "object" && value !== null, name);
  return Reflect.get(value, name);
}

await test("CLV-291 a theme color token gives the running lamp its color, and the logo stays the same", async () => {
  const plain = await shown("plain");
  assert.equal(plain["theme"], "plain");
  assert.equal(field(plain["running"], "color"), plainRunning);
  const fallback = await shown("broken");
  assert.equal(fallback["theme"], null);
  assert.equal(field(fallback["running"], "color"), defaultRunning);
  assert.equal(
    fallback["notice"],
    "The page uses the default theme: the theme broken is refused: invalid-color.",
  );
  const workshop = await shown("workshop");
  assert.deepEqual(plain["logo"], fallback["logo"]);
  assert.deepEqual(workshop["logo"], fallback["logo"]);
  assert.equal(field(fallback["logo"], "color"), "rgb(11, 191, 100)");
});

await test("CLV-291 a theme with station art draws the art at each station with its state mark", async () => {
  const workshop = await shown("workshop");
  assert.equal(workshop["classes"], "art-station");
  for (const name of ["running", "empty"]) {
    const station = workshop[name];
    assert.match(
      String(field(station, "image")),
      /url\(".*\/themes\/workshop\/assets\/bench\.svg"\)/,
    );
    assert.equal(field(station, "width"), "32px");
    assert.equal(field(station, "mark"), '""');
  }
  assert.equal(
    field(workshop["running"], "markColor"),
    "color(srgb 0.122 0.616 0.333)",
  );
  assert.notEqual(
    field(workshop["empty"], "markColor"),
    field(workshop["running"], "markColor"),
  );
  const plain = await shown("plain");
  assert.equal(field(plain["running"], "mark"), "none");
});

await test("CLV-291 the shelf heading counts completed runs with the word of the theme", async () => {
  const workshop = await shown("workshop", shelfModel());
  assert.equal(workshop["shelf"], "3 shoes");
});

await test("CLV-291 a choice in the theme menu applies at once and stays after a reload", async () => {
  const { themes, art } = await sceneThemes("workshop");
  await using fixture = await watchPageServer(twoLineModel(), {
    themes,
    files: { [bench]: { type: "image/svg+xml", body: art } },
  });
  await using browser = await realBrowser();
  const page = await browser.page({ width: 1280, height: 800 });
  await page.navigate(fixture.url);
  const before = await page.evaluate(measure);
  assert.equal(before["menu"], "workshop");
  assert.deepEqual(await page.evaluate(chosen("plain")), {
    theme: "plain",
    color: plainRunning,
  });
  await page.navigate(fixture.url);
  const after = await page.evaluate(measure);
  assert.equal(after["theme"], "plain");
  assert.equal(after["menu"], "plain");
  assert.equal(field(after["running"], "color"), plainRunning);
});
