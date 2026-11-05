import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ThemeFolders } from "../src/cli/theme-folders.ts";
import { themeFile, watchThemes } from "../src/cli/watch-themes.ts";
import { played } from "./watch-browser.ts";
import { twoLineModel } from "./watch-floor-fixture.ts";
import { watchPageServer } from "./watch-page-server.ts";
import { realBrowser } from "./watch-real-browser.ts";
import { workshopModel } from "./watch-workshop-fixture.ts";

const art = [
  "bench.svg",
  "bricks.svg",
  "pennants.svg",
  "shoe.svg",
  "tiles.svg",
  "worker.svg",
];

const automatic = `
globalThis.localStorage = { getItem: () => null, setItem: () => undefined };
location.hash = "";
replies.push(JSON.parse(process.env.WATCH_MODEL));
await load();
const options = app.all("select")[0].all("option").map((option) => option.text);
console.log(JSON.stringify({ theme: root.getAttribute("data-theme"), scheme: root.getAttribute("data-scheme"), options }));
`;

const workshop = `(async () => {
  const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  for (let attempt = 0; attempt < 300 && !document.querySelector(".station .lamp, .tile"); attempt++) await frame();
  await frame();
  const image = (selector, part, property) => {
    const node = document.querySelector(selector);
    return node === null ? null : getComputedStyle(node, part)[property];
  };
  const text = (selector) => document.querySelector(selector)?.textContent ?? null;
  const sizes = {};
  for (const name of ${JSON.stringify(art)}) {
    const picture = new Image();
    picture.src = "themes/workshop/assets/" + name;
    await picture.decode();
    sizes[name] = picture.naturalWidth > 0 && picture.naturalHeight > 0;
  }
  return {
    classes: document.documentElement.className,
    bench: image(".station .lamp", null, "backgroundImage"),
    worker: image(".token .token-worker", "::before", "backgroundImage"),
    shoe: image(".tile", "::after", "backgroundImage"),
    tiles: image(".floor", "::after", "maskImage"),
    bricks: image("header", "::after", "backgroundImage"),
    pennants: image(".line-name", "::after", "backgroundImage"),
    words: [text("#floor-title"), text("#today-title"), text("#needs-title"), text(".line-ready"), text(".shelf-count")],
    sizes,
  };
})()`;

async function builtInThemes(setting: string) {
  const root = await mkdtemp(join(tmpdir(), "cloving-built-in-themes-"));
  const folders: ThemeFolders = {
    project: join(root, "project"),
    user: join(root, "user"),
    builtIn: join(import.meta.dirname, "../themes"),
  };
  try {
    return { themes: await watchThemes({ setting, folders }), folders };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function artFiles(folders: ThemeFolders) {
  return Object.fromEntries(
    await Promise.all(
      art.map(async (name) => {
        const address = `/themes/workshop/assets/${name}`;
        const file = await themeFile(folders, address);
        assert.ok(file !== null, name);
        return [address, file] as const;
      }),
    ),
  );
}

await test("CLV-292 with watch.theme auto, a light browser shows Floor and a dark browser shows Floor at night", async () => {
  const { themes } = await builtInThemes("auto");
  const light = played({ ...twoLineModel(), themes }, automatic);
  assert.deepEqual(light, {
    theme: "floor",
    scheme: "light",
    options: ["Auto", "Floor", "Floor at night", "Workshop"],
  });
  const dark = played({ ...twoLineModel(), themes, dark: true }, automatic);
  assert.equal(dark["theme"], "floor-at-night");
  assert.equal(dark["scheme"], "dark");
});

await test("CLV-292 with Workshop, the page shows the benches, the worker sprites, the shoe badges and the Workshop words", async () => {
  const { themes, folders } = await builtInThemes("workshop");
  const files = await artFiles(folders);
  await using fixture = await watchPageServer(workshopModel(), {
    themes,
    files,
  });
  await using browser = await realBrowser();
  const page = await browser.page({ width: 1280, height: 900 });
  await page.navigate(fixture.url);
  const shown = await page.evaluate(workshop);
  assert.equal(
    shown["classes"],
    "art-floor art-floor-mask art-header art-line-banner art-station art-run-token art-completed-badge",
  );
  for (const name of ["bench", "worker", "shoe", "tiles", "bricks", "pennants"])
    assert.match(
      String(shown[name]),
      new RegExp(`url\\(".*/themes/workshop/assets/${name}\\.svg"\\)`),
      name,
    );
  assert.deepEqual(shown["words"], [
    "Workshop",
    "Bulletin board",
    "Inspector",
    "Help desk: 3",
    "3 shoes",
  ]);
  assert.deepEqual(
    shown["sizes"],
    Object.fromEntries(art.map((name) => [name, true])),
  );
});
