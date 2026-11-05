import assert from "node:assert/strict";
import { test } from "node:test";
import type { WatchThemes } from "../src/cli/watch-themes.ts";
import { watchThemes } from "../src/cli/watch-themes.ts";
import { played } from "./watch-browser.ts";
import { twoLineModel } from "./watch-floor-fixture.ts";
import { themeScene } from "./watch-theme-fixture.ts";

const scenario = (stored: string | null) => `
const store = ${JSON.stringify(stored === null ? {} : { "cloving.watch.theme": JSON.stringify(stored) })};
globalThis.localStorage = { getItem: (key) => store[key] ?? null, setItem: (key, value) => { store[key] = value; } };
location.hash = "";
const marks = () => ({ theme: root.getAttribute("data-theme"), scheme: root.getAttribute("data-scheme"), classes: root.getAttribute("class") });
replies.push(JSON.parse(process.env.WATCH_MODEL));
await load();
const before = marks();
const notice = app.all("p").filter((node) => node.attributes.get("class") === "theme-notice").map((node) => node.text);
const menu = app.all("select")[0];
const options = menu.all("option").map((option) => option.text);
menu.value = "plain";
menu.dispatch("change");
await settled();
const after = marks();
const words = app.all("h2").map((heading) => heading.text);
schemes.forEach((listener) => listener());
console.log(JSON.stringify({ before, after, options, chosen: menu.value, store, words, requests, notice }));
`;

async function sceneThemes(setting: string): Promise<WatchThemes> {
  await using folders = await themeScene();
  return await watchThemes({ setting, folders });
}

await test("CLV-291 a choice in the theme menu applies the theme at once and stays in the browser", async () => {
  const themes = await sceneThemes("workshop");
  const result = played({ ...twoLineModel(), themes }, scenario(null));
  assert.deepEqual(result["before"], {
    theme: "workshop",
    scheme: "light",
    classes: "art-station",
  });
  assert.deepEqual(result["options"], ["Auto", "Plain", "Workshop"]);
  assert.deepEqual(result["after"], {
    theme: "plain",
    scheme: "dark",
    classes: null,
  });
  assert.equal(result["chosen"], "plain");
  assert.deepEqual(result["store"], { "cloving.watch.theme": '"plain"' });
  assert.deepEqual(result["requests"], ["data.json"]);
  const again = played({ ...twoLineModel(), themes }, scenario("plain"));
  assert.deepEqual(again["before"], {
    theme: "plain",
    scheme: "dark",
    classes: null,
  });
});

await test("CLV-291 a refused selected theme leaves the page in the default theme and shows a notice", async () => {
  const themes = await sceneThemes("broken");
  const result = played({ ...twoLineModel(), themes }, scenario(null));
  assert.deepEqual(result["before"], {
    theme: null,
    scheme: null,
    classes: null,
  });
  assert.deepEqual(result["notice"], [
    "The page uses the default theme: the theme broken is refused: invalid-color.",
  ]);
});

await test("CLV-291 auto with no built-in theme of the color scheme uses the default theme with no notice", async () => {
  const themes = await sceneThemes("auto");
  const result = played(
    { ...twoLineModel(), themes, dark: true },
    scenario(null),
  );
  assert.deepEqual(result["before"], {
    theme: null,
    scheme: null,
    classes: null,
  });
  assert.deepEqual(result["notice"], []);
});

await test("CLV-291 a choice in the theme menu applies at once also when the browser refuses to keep it", async () => {
  const themes = await sceneThemes("workshop");
  const result = played(
    { ...twoLineModel(), themes },
    scenario(null).replace(
      "setItem: (key, value) => { store[key] = value; }",
      'setItem: () => { throw new Error("storage-refused"); }',
    ),
  );
  assert.deepEqual(result["store"], {});
  assert.deepEqual(result["after"], {
    theme: "plain",
    scheme: "dark",
    classes: null,
  });
  assert.equal(result["chosen"], "plain");
});
