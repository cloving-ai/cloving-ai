import assert from "node:assert/strict";
import { test } from "node:test";
import { themeClasses, themeRule, themeWords } from "../src/theme-style.ts";
import {
  withThemeData,
  withTokens,
  workshopTheme,
} from "./theme-check-fixture.ts";

await test("CLV-291 a theme rule sets one custom property for each token of the fixture theme", () => {
  const rule = themeRule({ name: "workshop", document: workshopTheme() });
  assert.ok(rule.startsWith(':root[data-theme="workshop"] {'), rule);
  assert.ok(rule.endsWith("}"), rule);
  for (const declaration of [
    "color-scheme: light;",
    "--color-page: color(srgb 0.843 0.855 0.835);",
    "--color-state-running: color(srgb 0.122 0.616 0.333);",
    "--shape-cut: 7px;",
  ])
    assert.ok(rule.includes(declaration), declaration);
  assert.equal(rule.match(/--color-/g)?.length, 2);
});

await test("CLV-291 hex colors, alpha, dimensions and font families become CSS values", () => {
  const rule = themeRule({
    name: "night",
    document: withTokens({
      color: {
        $type: "color",
        ink: { $value: "#E6F2EBCC" },
        code: {
          muted: {
            $value: {
              colorSpace: "srgb",
              components: [1, 0, 0.5],
              alpha: 0.25,
            },
          },
        },
      },
      size: { gap: { $type: "dimension", $value: { value: 0, unit: "px" } } },
      font: {
        $type: "fontFamily",
        ui: { $value: ["Barlow Semi Condensed", "system-ui", "sans-serif"] },
        code: { $value: ["Fira Code", "ui-monospace", "monospace"] },
      },
    }),
  });
  for (const declaration of [
    "--color-ink: #E6F2EBCC;",
    "--color-code-muted: color(srgb 1 0 0.5 / 0.25);",
    "--size-gap: 0px;",
    '--font-ui: "Barlow Semi Condensed", system-ui, sans-serif;',
    '--font-code: "Fira Code", ui-monospace, monospace;',
  ])
    assert.ok(rule.includes(declaration), `${declaration} in ${rule}`);
});

await test("CLV-291 each art slot of a theme becomes a custom property with its file address, repeat and rendering", () => {
  const document = withThemeData({
    colorScheme: "dark",
    art: {
      station: { src: "assets/bench.svg", mode: "image", pixelated: true },
      floor: { src: "assets/tiles/floor.png", mode: "mask", repeat: "both" },
      header: { src: "assets/bricks.webp", mode: "image", repeat: "x" },
    },
  });
  const rule = themeRule({ name: "workshop", document });
  for (const declaration of [
    "color-scheme: dark;",
    '--art-station: url("themes/workshop/assets/bench.svg");',
    "--art-station-repeat: no-repeat;",
    "--art-station-rendering: pixelated;",
    '--art-floor: url("themes/workshop/assets/tiles/floor.png");',
    "--art-floor-repeat: repeat;",
    "--art-floor-rendering: auto;",
    "--art-header-repeat: repeat-x;",
  ])
    assert.ok(rule.includes(declaration), `${declaration} in ${rule}`);
  assert.deepEqual(themeClasses(document), [
    "art-station",
    "art-floor",
    "art-floor-mask",
    "art-header",
  ]);
});

await test("CLV-291 a theme with no art has no art classes", () => {
  assert.deepEqual(themeClasses(withThemeData({ art: undefined })), []);
});

await test("CLV-291 the CSS and the words of a theme leave out each value that the theme check refuses", () => {
  const document = {
    color: {
      page: { $type: "color", $value: "red; } body { display: none" },
      ink: { $type: "color", $value: "#0E2310" },
    },
    size: { text: { $type: "dimension", $value: { value: 99, unit: "px" } } },
    font: { ui: { $type: "fontFamily", $value: ['Barlow"; } *{'] } },
    $extensions: {
      "ai.cloving.theme": {
        name: "Odd",
        colorScheme: "dark",
        art: {
          stage: { src: "assets/stage.svg", mode: "image" },
          station: {
            src: "assets/bench.svg",
            mode: "image",
            repeat: "diagonal",
          },
          floor: { src: "assets/tiles.png", mode: "image", repeat: "x" },
        },
        words: {
          "run.unit": 5,
          "ticket.unit": { one: "order" },
          "totals.label": "Bill",
        },
      },
    },
  };
  const rule = themeRule({ name: "odd", document });
  assert.equal(
    rule,
    ':root[data-theme="odd"] { color-scheme: dark; --color-ink: #0E2310; --art-floor: url("themes/odd/assets/tiles.png"); --art-floor-repeat: repeat-x; --art-floor-rendering: auto; }',
  );
  assert.deepEqual(themeClasses(document), ["art-floor"]);
  assert.deepEqual(themeWords(document), { "totals.label": "Bill" });
  assert.deepEqual(themeWords({}), {});
  assert.equal(
    themeRule({ name: "bare", document: {} }),
    ':root[data-theme="bare"] { color-scheme: light; }',
  );
});
