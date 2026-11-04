import assert from "node:assert/strict";
import { test } from "node:test";
import type { Fields } from "../src/protocol.ts";
import { checkedTheme } from "../src/theme-check.ts";
import { withTokens } from "./theme-check-fixture.ts";

function color(value: unknown): Fields {
  return { $type: "color", $value: value };
}

function cut(value: unknown): Fields {
  return { shape: { cut: { $type: "dimension", $value: value } } };
}

function codes(tokens: Fields): readonly string[] {
  return checkedTheme(withTokens(tokens)).codes;
}

const accepted: readonly (readonly [string, Fields])[] = [
  ["a six-digit hex color", { color: { page: color("#1F9D55") } }],
  ["an eight-digit hex color", { color: { ink: color("#1F9D55CC") } }],
  [
    "an srgb color object with alpha",
    {
      color: {
        line: color({ colorSpace: "srgb", components: [0, 0.5, 1], alpha: 1 }),
      },
    },
  ],
  [
    "a type from the group",
    {
      font: {
        $type: "fontFamily",
        $description: "Families of the page",
        ui: { $value: ["Space Grotesk", "system-ui"] },
        code: { $value: ["Fira Code", "ui-monospace"] },
      },
    },
  ],
  ["the smallest cut", cut({ value: 0, unit: "px" })],
  ["the largest cut", cut({ value: 32, unit: "px" })],
];

for (const [description, tokens] of accepted)
  await test(`CLV-290 a theme with ${description} has no refusal code`, () => {
    assert.deepEqual(codes(tokens), []);
  });

const refused: readonly (readonly [string, Fields, string])[] = [
  ["a dotted token name", { "color.page": color("#000000") }, "unknown-token"],
  [
    "a dotted name in a group",
    { color: { "code.text": color("#000000") } },
    "unknown-token",
  ],
  [
    "a name with braces",
    { color: { "{page}": color("#000000") } },
    "unknown-token",
  ],
  [
    "a group type that is not a token type",
    { color: { $type: "bogus" } },
    "invalid-token",
  ],
  ["a group type that is not text", { shape: { $type: 5 } }, "invalid-token"],
  [
    "a token in a group with a type that is not a token type",
    { color: { $type: "bogus", page: { $value: "#FFFFFF" } } },
    "invalid-token",
  ],
  [
    "a token type that is not a token type",
    { color: { page: { $type: "bogus", $value: "#FFFFFF" } } },
    "invalid-token",
  ],
  [
    "an unknown token name",
    { color: { sparkle: color("#FFFFFF") } },
    "unknown-token",
  ],
  [
    "an unknown token group",
    { motion: { fast: color("#FFFFFF") } },
    "unknown-token",
  ],
  ["a token in place of a group", { color: color("#FFFFFF") }, "unknown-token"],
  ["a color name", { color: { page: color("red") } }, "invalid-color"],
  ["a short hex color", { color: { page: color("#FFF") } }, "invalid-color"],
  [
    "a color in another color space",
    {
      color: {
        page: color({ colorSpace: "display-p3", components: [0, 0, 0] }),
      },
    },
    "invalid-color",
  ],
  [
    "a color component above one",
    { color: { page: color({ colorSpace: "srgb", components: [0, 2, 0] }) } },
    "invalid-color",
  ],
  [
    "a color with two components",
    { color: { page: color({ colorSpace: "srgb", components: [0, 0] }) } },
    "invalid-color",
  ],
  [
    "a color with an unknown member",
    {
      color: {
        page: color({ colorSpace: "srgb", components: [0, 0, 0], css: "x" }),
      },
    },
    "invalid-color",
  ],
  [
    "a color with a bad hex member",
    {
      color: {
        page: color({ colorSpace: "srgb", components: [0, 0, 0], hex: "red" }),
      },
    },
    "invalid-color",
  ],
  [
    "a color with an alpha above one",
    {
      color: {
        page: color({ colorSpace: "srgb", components: [0, 0, 0], alpha: 3 }),
      },
    },
    "invalid-color",
  ],
  [
    "a type that is not the type of the name",
    { shape: { cut: color("#FFFFFF") } },
    "token-type-mismatch",
  ],
  [
    "a token with no type",
    { color: { page: { $value: "#FFFFFF" } } },
    "invalid-token",
  ],
  [
    "a known name that is not a token",
    { color: { page: "#FFFFFF" } },
    "invalid-token",
  ],
  [
    "an unknown token property",
    { color: { page: { ...color("#FFFFFF"), $deprecated: true } } },
    "invalid-token",
  ],
  [
    "a description that is not text",
    { color: { $description: 4, page: color("#FFFFFF") } },
    "invalid-token",
  ],
  [
    "a cut above the range",
    cut({ value: 33, unit: "px" }),
    "invalid-dimension",
  ],
  [
    "a cut below the range",
    cut({ value: -1, unit: "px" }),
    "invalid-dimension",
  ],
  ["a cut in rem", cut({ value: 1, unit: "rem" }), "invalid-dimension"],
  ["a cut as text", cut("7px"), "invalid-dimension"],
  [
    "a cut with an unknown member",
    cut({ value: 1, unit: "px", css: "x" }),
    "invalid-dimension",
  ],
  [
    "a font family as one text",
    { font: { ui: { $type: "fontFamily", $value: "Space Grotesk" } } },
    "invalid-font-family",
  ],
  [
    "an empty font family list",
    { font: { ui: { $type: "fontFamily", $value: [] } } },
    "invalid-font-family",
  ],
  [
    "a font name with CSS text",
    { font: { ui: { $type: "fontFamily", $value: ["a; color: red"] } } },
    "invalid-font-family",
  ],
];

for (const [description, tokens, code] of refused)
  await test(`CLV-290 a theme with ${description} gives ${code}`, () => {
    assert.deepEqual(codes(tokens), [code]);
  });
