import assert from "node:assert/strict";
import { test } from "node:test";
import type { Fields } from "../src/protocol.ts";
import { checkedTheme } from "../src/theme-check.ts";
import {
  themeData,
  withThemeData,
  workshopTheme,
} from "./theme-check-fixture.ts";

function codes(theme: Fields): readonly string[] {
  return checkedTheme(theme).codes;
}

function art(slots: Fields): Fields {
  return withThemeData({ art: slots });
}

function station(changes: Fields): Fields {
  return art({
    station: { src: "assets/bench.svg", mode: "image", ...changes },
  });
}

function words(entries: Fields): Fields {
  return withThemeData({ words: entries });
}

const accepted: readonly (readonly [string, Fields])[] = [
  ["a dark color scheme", withThemeData({ colorScheme: "dark" })],
  ["no art and no words", withThemeData({ art: {}, words: {} })],
  ["a mask that repeats on x", station({ mode: "mask", repeat: "x" })],
  ["art with no repeat", station({ repeat: "none", pixelated: false })],
  [
    "all art slots",
    art(
      Object.fromEntries(
        [
          "floor",
          "header",
          "line-banner",
          "station",
          "run-token",
          "completed-badge",
        ].map((slot) => [slot, { src: `assets/${slot}.png`, mode: "image" }]),
      ),
    ),
  ],
  ["a WebP file in a subfolder", station({ src: "assets/benches/oak.webp" })],
  [
    "a plural word with the count",
    words({
      "completed.unit": { one: "{count} shoe", other: "{count} shoes" },
    }),
  ],
  [
    "a text word of 60 characters",
    words({ "workflows.title": "w".repeat(60) }),
  ],
  ["a word with parentheses", words({ "column.done": "Done (shipped)" })],
];

for (const [description, theme] of accepted)
  await test(`CLV-290 a theme with ${description} has no refusal code`, () => {
    assert.deepEqual(codes(theme), []);
  });

const theme = workshopTheme();
const refused: readonly (readonly [string, Fields, readonly string[]])[] = [
  ["no theme data", { ...theme, $extensions: {} }, ["missing-theme-data"]],
  [
    "another extension",
    {
      ...theme,
      $extensions: { "ai.cloving.theme": themeData(theme), "com.example": {} },
    },
    ["unknown-extension"],
  ],
  ["no name", withThemeData({ name: undefined }), ["invalid-name"]],
  ["an empty name", withThemeData({ name: "" }), ["invalid-name"]],
  ["a long name", withThemeData({ name: "n".repeat(61) }), ["invalid-name"]],
  ["a name that is a number", withThemeData({ name: 4 }), ["invalid-name"]],
  [
    "another color scheme",
    withThemeData({ colorScheme: "sepia" }),
    ["invalid-color-scheme"],
  ],
  [
    "an unknown data field",
    withThemeData({ css: "body {}" }),
    ["unknown-theme-field"],
  ],
  [
    "an unknown art slot",
    art({ sky: { src: "assets/sky.svg", mode: "image" } }),
    ["unknown-art-slot"],
  ],
  ["art that is a list", withThemeData({ art: [] }), ["invalid-art"]],
  [
    "art with no mode",
    art({ station: { src: "assets/bench.svg" } }),
    ["invalid-art"],
  ],
  ["a video mode", station({ mode: "video" }), ["invalid-art"]],
  ["a diagonal repeat", station({ repeat: "diagonal" }), ["invalid-art"]],
  ["a pixelated text", station({ pixelated: "yes" }), ["invalid-art"]],
  ["an art style field", station({ style: "color: red" }), ["invalid-art"]],
  [
    "art with no source",
    art({ station: { mode: "image" } }),
    ["invalid-asset-path"],
  ],
  [
    "a source above the theme",
    station({ src: "assets/../secret.svg" }),
    ["invalid-asset-path"],
  ],
  [
    "a source outside assets",
    station({ src: "bench.svg" }),
    ["invalid-asset-path"],
  ],
  [
    "an absolute source",
    station({ src: "/etc/bench.svg" }),
    ["invalid-asset-path"],
  ],
  [
    "a hidden source",
    station({ src: "assets/.bench.svg" }),
    ["invalid-asset-path"],
  ],
  [
    "a GIF source",
    station({ src: "assets/bench.gif" }),
    ["invalid-asset-type"],
  ],
  ["words that are a list", withThemeData({ words: [] }), ["invalid-word"]],
  [
    "an unknown word key",
    words({ "board.sparkle": "Sparkle" }),
    ["unknown-word"],
  ],
  [
    "a word of 61 characters",
    words({ "workflows.title": "w".repeat(61) }),
    ["invalid-word"],
  ],
  ["an empty word", words({ "column.done": "" }), ["invalid-word"]],
  [
    "a text word with plural forms",
    words({ "column.done": { one: "a", other: "b" } }),
    ["invalid-word"],
  ],
  [
    "a plural word as text",
    words({ "completed.unit": "shoes" }),
    ["invalid-word"],
  ],
  [
    "a plural word with no other form",
    words({ "completed.unit": { one: "shoe" } }),
    ["invalid-word"],
  ],
  [
    "a plural word with another form",
    words({ "completed.unit": { one: "a", other: "b", few: "c" } }),
    ["invalid-word"],
  ],
  [
    "a text word with the count",
    words({ "column.done": "{count} done" }),
    ["invalid-word"],
  ],
  [
    "a word with another placeholder",
    words({ "completed.unit": { one: "{n} shoe", other: "shoes" } }),
    ["invalid-word"],
  ],
  [
    "a word with a control character",
    words({ "column.done": "Done\u0007" }),
    ["invalid-word"],
  ],
  [
    "a word with url(",
    words({ "workflows.title": "url(https://example.com/a.png)" }),
    ["css-text"],
  ],
  ["a name with url(", withThemeData({ name: "Shop URL ( x )" }), ["css-text"]],
  [
    "a word with expression(",
    words({ "column.done": "expression(alert(1))" }),
    ["css-text"],
  ],
  [
    "a word with javascript:",
    words({ "column.done": "javascript:alert(1)" }),
    ["css-text"],
  ],
  ["a word with @import", words({ "column.done": "@import x" }), ["css-text"]],
  [
    "a word with a tag",
    words({ "column.done": "<b>Done</b>" }),
    ["css-text", "invalid-word"],
  ],
];

for (const [description, refusedTheme, expected] of refused)
  await test(`CLV-290 a theme with ${description} gives ${expected.join(" and ")}`, () => {
    assert.deepEqual(codes(refusedTheme), expected);
  });

await test("CLV-290 a document that is not an object gives missing-theme-data", () => {
  assert.deepEqual(checkedTheme([]), {
    codes: ["missing-theme-data"],
    title: null,
    colorScheme: null,
    assets: [],
  });
});

await test("CLV-290 the check lists each valid asset path one time", () => {
  const checked = checkedTheme(
    art({
      station: { src: "assets/bench.svg", mode: "image" },
      floor: { src: "assets/bench.svg", mode: "mask" },
      header: { src: "../x.svg", mode: "image" },
    }),
  );
  assert.deepEqual(checked.assets, ["assets/bench.svg"]);
});

await test("CLV-290 a deeply nested value gives a refusal code and does not stop the check", () => {
  let nested: unknown = "url(x)";
  for (let depth = 0; depth < 200_000; depth += 1) nested = [nested];
  assert.deepEqual(codes(words({ "column.done": nested })), [
    "css-text",
    "invalid-word",
  ]);
});

await test("CLV-292 a theme can name the Today panel, the Needs you panel and the ready count of a line", () => {
  assert.deepEqual(
    codes(
      words({
        "today.title": "Bulletin board",
        "needs.title": "Inspector",
        "ready.count": {
          one: "Help desk: {count}",
          other: "Help desk: {count}",
        },
      }),
    ),
    [],
  );
  assert.deepEqual(codes(words({ "ready.count": "Help desk" })), [
    "invalid-word",
  ]);
  assert.deepEqual(
    codes(words({ "today.title": { one: "Board", other: "Boards" } })),
    ["invalid-word"],
  );
});
