import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { WatchModel } from "../src/cli/watch-render.ts";
import { watchThemes, type WatchThemes } from "../src/cli/watch-themes.ts";
import { withThemeData } from "./theme-check-fixture.ts";
import { writeTheme } from "./theme-scene-fixture.ts";
import { floorModel, floorRun, twoLineModel } from "./watch-floor-fixture.ts";
import { watchPageServer } from "./watch-page-server.ts";
import { realBrowser } from "./watch-real-browser.ts";
import { shelfModel } from "./watch-shelf-fixture.ts";
import { themeScene } from "./watch-theme-fixture.ts";

const bench = "/themes/workshop/assets/bench.svg";
const maskedBench = "/themes/masked/assets/bench.svg";
const themeRunning = "color(srgb 0.122 0.616 0.333)";
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

const layers = `(async () => {
  const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  for (let attempt = 0; attempt < 300 && !document.querySelector(".station .lamp.running, .token.waiting"); attempt++) await frame();
  await frame();
  const style = (selector, part) => {
    const node = document.querySelector(selector);
    if (node === null) return null;
    const shown = getComputedStyle(node, part);
    return { mask: shown.maskImage, color: shown.backgroundColor, content: shown.content };
  };
  return {
    classes: document.documentElement.className,
    lamp: style(".station .lamp.running", null),
    art: style(".station .lamp.running", "::before"),
    mark: style(".station .lamp.running", "::after"),
    running: style(".token.running .token-worker", "::before"),
    waiting: style(".token.waiting .token-worker", "::before"),
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
  await writeTheme(
    join(folders.project, "masked"),
    withThemeData({
      name: "Masked",
      art: {
        station: { src: "assets/bench.svg", mode: "mask" },
        "run-token": { src: "assets/bench.svg", mode: "mask" },
      },
    }),
  );
  return {
    themes: await watchThemes({ setting, folders }),
    art: await readFile(join(folders.project, "workshop/assets/bench.svg")),
  };
}

async function evaluated(input: {
  readonly setting: string;
  readonly model: WatchModel;
  readonly script: string;
}): Promise<Record<string, unknown>> {
  const { themes, art } = await sceneThemes(input.setting);
  const file = { type: "image/svg+xml", body: art };
  await using fixture = await watchPageServer(input.model, {
    themes,
    files: { [bench]: file, [maskedBench]: file },
  });
  await using browser = await realBrowser();
  const page = await browser.page({ width: 1280, height: 800 });
  await page.navigate(fixture.url);
  return await page.evaluate(input.script);
}

function shown(
  setting: string,
  model: WatchModel = twoLineModel(),
): Promise<Record<string, unknown>> {
  return evaluated({ setting, model, script: measure });
}

function maskedLayers(): Promise<Record<string, unknown>> {
  return evaluated({
    setting: "masked",
    script: layers,
    model: floorModel([
      floorRun("turn-585", {
        operation: "claude-turn",
        minutes: 3,
        ticketId: "585",
        harness: "claude",
      }),
      floorRun("pr-586", {
        operation: "github-open-pr",
        minutes: 2,
        ticketId: "586",
        harness: "claude",
        awaitedRunId: "turn-585",
      }),
    ]),
  });
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

await test("CLV-291 a mask theme draws the station art on its own layer, so the state mark of the station stays visible", async () => {
  const masked = await maskedLayers();
  assert.equal(
    masked["classes"],
    "art-station art-station-mask art-run-token art-run-token-mask",
  );
  assert.equal(field(masked["lamp"], "mask"), "none");
  assert.match(
    String(field(masked["art"], "mask")),
    /url\(".*\/themes\/masked\/assets\/bench\.svg"\)/,
  );
  assert.equal(field(masked["art"], "color"), themeRunning);
  assert.equal(field(masked["mark"], "content"), '""');
  assert.equal(field(masked["mark"], "mask"), "none");
  assert.equal(field(masked["mark"], "color"), themeRunning);
});

await test("CLV-291 a mask run token draws its sprite in the text color of its state, dark on a waiting token", async () => {
  const masked = await maskedLayers();
  for (const name of ["running", "waiting"])
    assert.match(
      String(field(masked[name], "mask")),
      /url\(".*\/themes\/masked\/assets\/bench\.svg"\)/,
      name,
    );
  assert.equal(field(masked["running"], "color"), "rgb(255, 255, 255)");
  assert.equal(field(masked["waiting"], "color"), "rgb(36, 27, 0)");
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
