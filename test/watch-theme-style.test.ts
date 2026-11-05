import assert from "node:assert/strict";
import { test } from "node:test";
import { artSlots } from "../src/theme-art.ts";
import { themeTokens } from "../src/theme-tokens.ts";
import { css, rule, rules } from "./watch-style-fixture.ts";

const tokenProperties = Object.keys(themeTokens).map(
  (name) => `--${name.replaceAll(".", "-")}`,
);
const fixedColors = [
  "--on-lamp",
  "--on-waiting",
  "--line-1",
  "--line-2",
  "--line-3",
  "--line-4",
];
const literalColor = /#[0-9A-Fa-f]{3,8}\b|rgba?\(/g;
const pageRules = rules.replaceAll(/@font-face \{[^}]*\}/g, "");

function declarations(): readonly (readonly [string, string])[] {
  return [...pageRules.matchAll(/(--[\w-]+): ([^;]+);/g)].map(
    ([, name = "", value = ""]) => [name, value],
  );
}

await test("CLV-291 the page sets a default for each theme token as a custom property", () => {
  const defaults = rule(":root");
  for (const property of tokenProperties)
    assert.match(defaults, new RegExp(`${property}: [^;]+;`), property);
  assert.match(defaults, /font: var\(--size-text\)\/1\.5 var\(--font-ui\);/);
  assert.match(
    defaults,
    /--angled: polygon\(var\(--shape-cut\) 0, 100% 0, 100% calc\(100% - var\(--shape-cut\)\), calc\(100% - var\(--shape-cut\)\) 100%, 0 100%, 0 var\(--shape-cut\)\);/,
  );
});

await test("CLV-291 the page takes its colors only from the token properties, except the logo, the line colors and the marks on state colors", () => {
  const colored = declarations()
    .filter(([, value]) => value.match(literalColor) !== null)
    .map(([name]) => name);
  assert.ok(colored.length > 30);
  assert.deepEqual(
    colored.filter(
      (name) => !tokenProperties.includes(name) && !fixedColors.includes(name),
    ),
    [],
  );
  const outside = pageRules.replaceAll(/--[\w-]+: [^;]+;/g, "");
  assert.deepEqual([...new Set(outside.match(literalColor))].sort(), [
    "#000000",
    "#0BBF64",
    "#FF7B72",
    "rgba(",
  ]);
  assert.match(rule(".brand svg"), /color: #0BBF64;/);
  assert.doesNotMatch(
    pageRules,
    /var\(--(bg|surface|surface-2|ink|muted|line|accent|accent-strong|warn|bad|code-bg|code-head|code-fg|running|waiting|needs-you|stopped|cut|heading-font|body-font|code-font)\)/,
  );
});

await test("CLV-291 the page takes its fonts, corners, borders and gaps from the token properties, except the logo", () => {
  const fonts = [
    ...pageRules.matchAll(/\n([^{}\n]+) \{[^}]*\bfont(?:-family)?: ([^;]+);/g),
  ];
  assert.ok(fonts.length > 20);
  const themed = fonts.filter(([, selector]) => selector !== ".brand");
  assert.equal(themed.length, fonts.length - 1);
  for (const [, selector = "", value = ""] of themed)
    assert.match(value, /var\(--font-(ui|heading|code)\)|inherit/, selector);
  assert.match(
    rule(".brand"),
    /font: 800 26px\/1\.2 "Heebo", system-ui, sans-serif;/,
  );
  for (const selector of [".column", ".card", ".banner", ".code-window"])
    assert.match(rule(selector), /border-radius: var\(--shape-radius\)/);
  assert.doesNotMatch(css, /border-radius: 14px/);
  assert.doesNotMatch(css, /inset 0 0 0 1px|1px solid var/);
  for (const selector of [".floor-layout", ".floor-main"])
    assert.match(rule(selector), /gap: var\(--size-gap\)/);
});

await test("CLV-291 the dark defaults follow the browser only when no theme sets a color scheme", () => {
  assert.match(
    css,
    /@media \(prefers-color-scheme: dark\) \{\n\s*:root:not\(\[data-scheme="light"\]\) \{/,
  );
  for (const selector of [
    ':root:not([data-scheme="light"])',
    ':root[data-scheme="dark"]',
  ])
    assert.match(
      rule(selector),
      /color-scheme: dark;[^}]*--color-page: #141C18;/,
    );
  assert.doesNotMatch(css, /data-theme/);
});

await test("CLV-291 each art slot has page rules for its class, its mask class and its custom properties", () => {
  for (const slot of artSlots) {
    for (const part of [
      `.art-${slot} `,
      `.art-${slot}-mask `,
      `var(--art-${slot})`,
      `var(--art-${slot}-repeat)`,
      `var(--art-${slot}-rendering)`,
    ])
      assert.ok(css.includes(part), `${slot}: ${part}`);
  }
  assert.match(
    rule(".art-run-token .token .token-worker"),
    /color: transparent/,
  );
  assert.match(rule(".theme-notice"), /flex-basis: 100%/);
});

await test("CLV-286 the floor states use custom properties with the light theme colors as defaults", () => {
  const defaults = rule(":root");
  for (const [state, token, color] of [
    ["running", "running", "#1F9D55"],
    ["waiting", "waiting", "#D9A400"],
    ["needs-you", "attention", "#0B5FB0"],
    ["stopped", "failed", "#C21F32"],
  ] as const) {
    assert.ok(defaults.includes(`--color-state-${token}: ${color};`), state);
    assert.match(
      rule(`.lamp.${state}, .token.${state}`),
      new RegExp(`--state: var\\(--color-state-${token}\\)`),
    );
  }
  assert.match(
    rule(".lamp"),
    /background: var\(--state, var\(--color-surface\)\)/,
  );
  assert.match(rule(".lamp"), /transform: rotate\(45deg\)/);
  assert.match(rule(".token-worker"), /background: var\(--state\)/);
});
