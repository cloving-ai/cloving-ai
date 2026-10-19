import assert from "node:assert/strict";
import { test } from "node:test";
import { pageDocument } from "../src/cli/watch-page.ts";
import { contrast, over, palette, rgb } from "./watch-style-fixture.ts";

const css = pageDocument().split("<style>")[1]?.split("</style>")[0] ?? "";
const rules = css.replaceAll(/\n[ \t]+/g, "\n");
function rule(selector: string): string {
  const start = rules.indexOf(`\n${selector} {`);
  assert.ok(start >= 0, selector);
  return rules.slice(start, rules.indexOf("}", start));
}

await test("CLV-140 tabs scroll in one row above a full-width board with flexible columns", () => {
  assert.match(rule(".workspace"), /display: flex/);
  assert.match(rule(".workspace"), /width: 100%/);
  assert.doesNotMatch(rule(".workspace"), /grid-template-columns/);
  assert.match(rule(".board"), /width: 100%/);
  assert.match(rule(".workflows"), /flex-direction: row/);
  assert.match(rule(".workflows"), /flex-shrink: 0/);
  assert.match(rule(".workflows"), /overflow-x: auto/);
  assert.match(rule(".workflows"), /overflow-y: hidden/);
  assert.match(rule(".workflows a"), /flex-shrink: 0/);
  assert.match(rule(".workflows a"), /white-space: nowrap/);
  assert.match(rule(".column"), /flex: 1 0 200px/);
  assert.match(rule(".column"), /min-width: 200px/);
  assert.match(rule(".column.collapsed"), /flex: 0 0 44px/);
  assert.match(rule(".column.collapsed"), /min-width: 44px/);
  assert.match(rule(".columns"), /gap: 12px/);
});

await test("CLV-134 the board fills the viewport with independent column scrolling", () => {
  assert.match(rule(".board-page"), /height: 100dvh/);
  assert.match(rule(".board-page"), /overflow: hidden/);
  for (const selector of [".workspace", ".board", ".columns"])
    assert.match(rule(selector), /min-height: 0/);
  assert.match(rule(".columns"), /overflow-x: scroll/);
  assert.match(rule(".columns"), /overflow-y: hidden/);
  assert.match(rule(".columns"), /align-items: flex-start/);
  assert.match(rule(".column"), /max-height: 100%/);
  assert.match(rule(".column"), /display: flex/);
  assert.match(rule(".column-name"), /flex-shrink: 0/);
  assert.match(rule(".column-cards"), /overflow-y: auto/);
  assert.match(rule(".column-cards"), /min-height: 0/);
  assert.match(rule(".collapsed .column-name"), /writing-mode: vertical-rl/);
  assert.match(css, /@media \(max-width: 700px\)[\s\S]*padding-inline: 12px/);
});

await test("CLV-134 card titles use two lines and step and review metadata each stay on one line", () => {
  assert.match(rule(".card-run strong"), /-webkit-line-clamp: 2/);
  assert.match(rule(".card-run strong"), /overflow: hidden/);
  assert.match(rule(".card-step, .card-review"), /white-space: nowrap/);
  assert.match(rule(".card-step, .card-review"), /text-overflow: ellipsis/);
});

await test("CLV-134 custom scrollbar sizing wins over native styling while theme colors remain", () => {
  assert.match(rule(".columns::-webkit-scrollbar"), /height: 12px/);
  assert.match(
    css,
    /@supports selector\(::-webkit-scrollbar\)\s*\{\s*\.columns\s*\{\s*scrollbar-color: auto;/,
  );
  assert.match(
    rule(".columns"),
    /scrollbar-color: var\(--muted\) var\(--surface-2\)/,
  );
  assert.match(
    rule(".columns::-webkit-scrollbar-track"),
    /background: var\(--surface-2\)/,
  );
  assert.match(
    rule(".columns::-webkit-scrollbar-thumb"),
    /background: var\(--muted\)/,
  );
});

await test("CLV-098 every palette token belongs to default, system and explicit theme rules", () => {
  const system = ':root:not([data-theme="light"]):not([data-theme="dark"])';
  for (const [theme, tokens] of Object.entries(palette)) {
    const selectors = [
      theme === "light" ? ":root" : system,
      `:root[data-theme="${theme}"]`,
    ];
    for (const selector of selectors) {
      const declarations = rule(selector).replaceAll(/\s/g, "").toLowerCase();
      assert.ok(declarations.includes(`color-scheme:${theme};`));
      for (const [token, value] of Object.entries(tokens))
        assert.ok(
          declarations.includes(
            `--${token}:${value.replaceAll(/\s/g, "").toLowerCase()};`,
          ),
          `${selector} ${token}`,
        );
    }
  }
  assert.ok(
    css.indexOf("@media (prefers-color-scheme: dark)") <
      css.indexOf(':root[data-theme="light"]'),
  );
  assert.ok(
    css.indexOf(':root[data-theme="light"]') <
      css.indexOf(':root[data-theme="dark"]'),
  );
});

await test("CLV-098 font stacks retain system fallbacks, including activity messages", () => {
  assert.match(css, /--heading-font: "Heebo",[^;]*sans-serif;/);
  assert.match(css, /--body-font: "Space Grotesk",[^;]*sans-serif;/);
  assert.match(css, /--code-font: "Fira Code",[^;]*monospace;/);
  assert.match(rule(".brand"), /font: 800 [^;]*var\(--heading-font\)/);
  for (const selector of [".item.say", ".item.result"])
    assert.match(rule(selector), /var\(--body-font\)/);
});

await test("CLV-098 board surfaces, state cues, focus and narrow command wrapping use the design tokens", () => {
  assert.match(
    rule('.workflows a[aria-current="page"]'),
    /border-bottom-color: var\(--accent\)/,
  );
  for (const selector of [".column", ".card"]) {
    const declarations = rule(selector);
    assert.match(declarations, /border-radius: 14px/);
    assert.match(declarations, /inset 0 0 0 1px var\(--line\)/);
    assert.match(declarations, /background: var\(--surface/);
  }
  assert.match(rule(".card-step.active"), /color: var\(--accent-strong\)/);
  assert.match(rule(".decision-mark"), /background: [^;]*var\(--warn-tint\)/);
  assert.match(rule(".column.stopped"), /var\(--bad-tint\)/);
  assert.match(rule(".stopped .card"), /var\(--bad-tint\)/);
  assert.match(rule(".stopped .column-name"), /color: var\(--bad\)/);
  assert.match(rule(".columns"), /overflow-x: scroll/);
  assert.match(rule(".command code"), /overflow-wrap: anywhere/);
  assert.match(rule(".command code"), /white-space: pre-wrap/);
  assert.match(
    rule(
      "a:focus-visible, button:focus-visible, summary:focus-visible, input:focus-visible, textarea:focus-visible",
    ),
    /outline: 3px solid var\(--accent\)/,
  );
  assert.match(
    rule(
      "a:focus-visible, button:focus-visible, summary:focus-visible, input:focus-visible, textarea:focus-visible",
    ),
    /0 0 0 6px var\(--code-bg\)/,
  );
});

await test("CLV-098 phases are stations and activity, events and commands have always-dark windows and ghost controls", () => {
  assert.match(rule(".phases"), /background: var\(--surface\)/);
  assert.match(rule(".phase .mark"), /border-radius: 50%/);
  assert.match(rule(".code-window"), /background: var\(--code-bg\)/);
  assert.match(rule(".code-head"), /background: var\(--code-head\)/);
  assert.match(
    rule(".code-window .bad, .code-window .item.error"),
    /color: #FF7B72/,
  );
  assert.match(rule("button"), /background: transparent/);
  assert.match(rule("button"), /inset 0 0 0 2px var\(--code-line\)/);
});

await test("CLV-098 text and focus colors meet contrast in both themes, with composited tints", () => {
  assert.equal(contrast(rgb("#000000"), rgb("#FFFFFF")), 21);
  assert.equal(contrast(rgb("#123456"), rgb("#123456")), 1);
  for (const tokens of Object.values(palette)) {
    for (const background of [tokens.bg, tokens.surface, tokens["surface-2"]]) {
      for (const text of [
        tokens.ink,
        tokens.muted,
        tokens["accent-strong"],
        tokens.bad,
        tokens.warn,
      ])
        assert.ok(
          contrast(rgb(text), rgb(background)) >= 4.5,
          `${text} on ${background}`,
        );
    }
    for (const tint of ["accent-tint", "bad-tint"] as const) {
      const background = over(tokens[tint], rgb(tokens.surface));
      for (const text of [tokens.ink, tokens.muted, tokens["accent-strong"]])
        assert.ok(contrast(rgb(text), background) >= 4.5, `${text} on ${tint}`);
    }
    assert.ok(
      contrast(
        rgb(tokens.warn),
        over(tokens["warn-tint"], rgb(tokens.surface)),
      ) >= 4.5,
    );
  }
});

await test("CLV-098 dark code text and separated accent focus outlines meet contrast in either theme", () => {
  for (const tokens of Object.values(palette)) {
    for (const background of [tokens["code-bg"], tokens["code-head"]]) {
      for (const text of [
        tokens["code-fg"],
        tokens["code-muted"],
        "#FF7B72",
        tokens.accent,
      ])
        assert.ok(
          contrast(rgb(text), rgb(background)) >= 4.5,
          `${text} on ${background}`,
        );
    }
    assert.ok(contrast(rgb(tokens.accent), rgb(tokens["code-bg"])) >= 3);
  }
});

await test("CLV-098 warning tags remain readable over a Stopped card's red tint", () => {
  const declaration = /background: ([^;]+)/.exec(rule(".decision-mark"))?.[1];
  assert.ok(declaration);
  const layers = [
    ...new Set(
      [...declaration.matchAll(/var\(--([\w-]+)\)/g)].map((match) => match[1]),
    ),
  ];
  for (const tokens of Object.values(palette)) {
    const colors: Readonly<Record<string, string>> = tokens;
    const stopped = over(tokens["bad-tint"], rgb(tokens.surface));
    const tag = layers.toReversed().reduce((base, token) => {
      assert.ok(token);
      const color = colors[token];
      assert.ok(color);
      return over(color, base);
    }, stopped);
    assert.ok(
      contrast(rgb(tokens.warn), tag) >= 4.5,
      `${tokens.warn} over stopped warning tag`,
    );
  }
});

await test("CLV-098 run tones retain green, warning, red and neutral cues and readable code text", () => {
  for (const selector of [
    ".working .icon, .phase.active .mark, .banner.working h2",
    ".good .icon, .phase.done .mark, p.good",
  ])
    assert.match(rule(selector), /color: var\(--accent-strong\)/);
  assert.match(rule(".attention .icon"), /color: var\(--warn\)/);
  assert.match(
    rule(".bad .icon, .phase.failed .mark, .bad, .down"),
    /color: var\(--bad\)/,
  );
  assert.match(rule(".icon"), /color: var\(--muted\)/);
  assert.match(rule(".banner"), /border-left: 6px solid var\(--muted\)/);
  assert.match(rule(".code-window"), /color: var\(--code-fg\)/);
  assert.match(
    rule(".code-window summary, .code-window .event, .code-window .item.tool"),
    /color: var\(--code-muted\)/,
  );
  assert.match(rule(".code-window .item.result"), /color: var\(--accent\)/);
  assert.match(rule("button"), /color: var\(--code-fg\)/);
});

await test("CLV-135 add-card controls use readable theme colors and fields fit narrow columns", () => {
  assert.match(rule(".add-card, .add-card-form button"), /color: var\(--ink\)/);
  assert.match(
    rule(".add-card-form input, .add-card-form textarea"),
    /width: 100%/,
  );
  assert.match(
    rule(".add-card-form input, .add-card-form textarea"),
    /color: var\(--ink\)/,
  );
  assert.match(
    rule(".add-card-form input, .add-card-form textarea"),
    /background: var\(--surface\)/,
  );
  assert.match(css, /input:focus-visible, textarea:focus-visible/);
});
