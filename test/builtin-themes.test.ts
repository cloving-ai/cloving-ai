import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { record, type Fields } from "../src/protocol.ts";
import { checkedTheme } from "../src/theme-check.ts";

const themes = [
  { name: "floor", title: "Floor", colorScheme: "light" },
  { name: "floor-at-night", title: "Floor at night", colorScheme: "dark" },
  { name: "workshop", title: "Workshop", colorScheme: "light" },
] as const;

const textTokens = [
  "color.ink",
  "color.muted",
  "color.accent-strong",
  "color.warn",
  "color.bad",
];
const panelTokens = ["color.page", "color.surface", "color.panel"];
const codePairs = [
  ["color.code.text", "color.code.background"],
  ["color.code.text", "color.code.header"],
  ["color.code.muted", "color.code.background"],
  ["color.code.muted", "color.code.header"],
  ["color.on-accent", "color.accent"],
] as const;

function themeDocument(name: string): Fields {
  const text = readFileSync(
    new URL(`../themes/${name}/theme.json`, import.meta.url),
    "utf8",
  );
  return record(JSON.parse(text)) ?? {};
}

function token(document: Fields, name: string): Fields {
  let node: unknown = document;
  for (const part of name.split(".")) node = record(node)?.[part];
  const value = record(record(node)?.["$value"]);
  assert.ok(value !== undefined, name);
  return value;
}

function channels(document: Fields, name: string): readonly number[] {
  const value = token(document, name);
  const components = value["components"];
  assert.ok(Array.isArray(components), name);
  return components.map(Number);
}

function hexChannels(document: Fields, name: string): readonly number[] {
  const hex = String(token(document, name)["hex"]);
  return [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16));
}

function luminance(color: readonly number[]): number {
  const linear = color.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  const [red = 0, green = 0, blue = 0] = linear;
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(
  document: Fields,
  pair: { readonly text: string; readonly panel: string },
): number {
  const [lighter, darker] = [
    luminance(channels(document, pair.text)),
    luminance(channels(document, pair.panel)),
  ].sort((first, second) => second - first);
  return ((lighter ?? 0) + 0.05) / ((darker ?? 0) + 0.05);
}

function hue(color: readonly number[]): number {
  const [red = 0, green = 0, blue = 0] = color;
  const high = Math.max(red, green, blue);
  const span = high - Math.min(red, green, blue);
  if (span === 0) return 0;
  if (high === red) return (((green - blue) / span + 6) % 6) * 60;
  if (high === green) return ((blue - red) / span + 2) * 60;
  return ((red - green) / span + 4) * 60;
}

function colorTokens(document: Fields): readonly string[] {
  const names: string[] = [];
  const walk = (node: unknown, path: string): void => {
    const fields = record(node);
    if (fields === undefined) return;
    if (Object.hasOwn(fields, "$value")) {
      names.push(path);
      return;
    }
    for (const [key, child] of Object.entries(fields))
      if (!key.startsWith("$")) walk(child, `${path}.${key}`);
  };
  walk(document["color"], "color");
  return names;
}

await test("CLV-292 the three built-in themes pass the theme check with their names and color schemes", () => {
  for (const theme of themes) {
    const checked = checkedTheme(themeDocument(theme.name));
    assert.deepEqual(checked.codes, [], theme.name);
    assert.equal(checked.title, theme.title);
    assert.equal(checked.colorScheme, theme.colorScheme);
  }
});

await test("CLV-292 each text token has a contrast of at least 4.5:1 on each panel token in each theme", () => {
  const pairs = [
    ...textTokens.flatMap((text) =>
      panelTokens.map((panel) => ({ text, panel })),
    ),
    ...codePairs.map(([text, panel]) => ({ text, panel })),
  ];
  assert.equal(pairs.length, 20);
  const low = themes.flatMap((theme) => {
    const document = themeDocument(theme.name);
    return pairs
      .map((pair) => ({
        theme: theme.name,
        ...pair,
        ratio: Math.round(contrast(document, pair) * 100) / 100,
      }))
      .filter((pair) => pair.ratio < 4.5);
  });
  assert.deepEqual(low, []);
});

await test("CLV-292 the white answer text has a contrast of at least 4.5:1 on the attention color in each theme", () => {
  const low = themes
    .map((theme) => {
      const attention = luminance(
        channels(themeDocument(theme.name), "color.state.attention"),
      );
      return {
        theme: theme.name,
        ratio: Math.round((1.05 / (attention + 0.05)) * 100) / 100,
      };
    })
    .filter((pair) => pair.ratio < 4.5);
  assert.deepEqual(low, []);
});

await test("CLV-292 the needs-you count in the attention color has a contrast of at least 3:1 on the page in each theme", () => {
  const low = themes
    .map((theme) => {
      const document = themeDocument(theme.name);
      return {
        theme: theme.name,
        ratio:
          Math.round(
            contrast(document, {
              text: "color.state.attention",
              panel: "color.page",
            }) * 100,
          ) / 100,
      };
    })
    .filter((pair) => pair.ratio < 3);
  assert.deepEqual(low, []);
});

await test("CLV-292 the hex value of each color agrees with its components", () => {
  for (const theme of themes) {
    const document = themeDocument(theme.name);
    const names = colorTokens(document);
    assert.equal(names.length, 21, theme.name);
    for (const name of names)
      assert.deepEqual(
        channels(document, name).map((channel) => Math.round(channel * 255)),
        hexChannels(document, name),
        `${theme.name} ${name}`,
      );
  }
});

await test("CLV-292 the Floor themes use the safety colors for the states and angled corners of 7 px", () => {
  const hues = [
    ["color.state.running", 100, 170],
    ["color.state.waiting", 38, 60],
    ["color.state.attention", 195, 230],
    ["color.state.failed", 340, 365],
  ] as const;
  for (const name of ["floor", "floor-at-night"]) {
    const document = themeDocument(name);
    for (const [state, low, high] of hues) {
      const shown = hue(channels(document, state));
      const turned = shown < 180 && low > 300 ? shown + 360 : shown;
      assert.ok(
        turned >= low && turned <= high,
        `${name} ${state} ${String(shown)}`,
      );
    }
    assert.deepEqual(record(record(document["shape"])?.["cut"])?.["$value"], {
      value: 7,
      unit: "px",
    });
  }
});
