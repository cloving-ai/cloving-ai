import assert from "node:assert/strict";
import { test } from "node:test";
import {
  colorTokens,
  contrast,
  css,
  over,
  palette,
  rgb,
  rule,
  rules,
} from "./watch-style-fixture.ts";

await test("CLV-140 a full-width board has flexible columns", () => {
  assert.match(rule(".workspace"), /display: flex/);
  assert.match(rule(".workspace"), /width: 100%/);
  assert.doesNotMatch(rule(".workspace"), /grid-template-columns/);
  assert.match(rule(".board"), /width: 100%/);
  assert.match(rule(".column"), /flex: 1 0 200px/);
  assert.match(rule(".column"), /min-width: 200px/);
  assert.match(rule(".column.collapsed"), /flex: 0 0 44px/);
  assert.match(rule(".column.collapsed"), /min-width: 44px/);
  assert.match(rule(".columns"), /gap: 12px/);
});

await test("the version label of the watch page stays at the bottom left", () => {
  assert.match(rule(".version"), /position: fixed/);
  assert.match(rule(".version"), /left: 12px/);
  assert.match(rule(".version"), /bottom: 8px/);
  assert.match(rule(".version"), /color: var\(--color-muted\)/);
  assert.match(rule(".version"), /pointer-events: none/);
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
    /scrollbar-color: var\(--color-muted\) var\(--color-panel\)/,
  );
  assert.match(
    rule(".columns::-webkit-scrollbar-track"),
    /background: var\(--color-panel\)/,
  );
  assert.match(
    rule(".columns::-webkit-scrollbar-thumb"),
    /background: var\(--color-muted\)/,
  );
});

await test("CLV-098 every color token belongs to the default, system and explicit dark rules", () => {
  const system = ':root:not([data-scheme="light"])';
  for (const [scheme, tokens] of Object.entries(colorTokens)) {
    const selectors =
      scheme === "light" ? [":root"] : [system, ':root[data-scheme="dark"]'];
    for (const selector of selectors) {
      const declarations = rule(selector).replaceAll(/\s/g, "").toLowerCase();
      assert.ok(declarations.includes(`color-scheme:${scheme};`));
      for (const [token, value] of Object.entries(tokens))
        assert.ok(
          declarations.includes(`--${token}:${value.toLowerCase()};`),
          `${selector} ${token}`,
        );
    }
  }
  assert.ok(
    css.indexOf("@media (prefers-color-scheme: dark)") <
      css.indexOf(':root[data-scheme="dark"]'),
  );
});

await test("CLV-098 font stacks retain system fallbacks, including activity messages", () => {
  assert.match(css, /--font-heading: "Heebo",[^;]*sans-serif;/);
  assert.match(css, /--font-ui: "Space Grotesk",[^;]*sans-serif;/);
  assert.match(css, /--font-code: "Fira Code",[^;]*monospace;/);
  assert.match(rule(".brand"), /font: 800 [^;]*"Heebo", system-ui, sans-serif/);
  for (const selector of [".item.say", ".item.result"])
    assert.match(rule(selector), /var\(--font-ui\)/);
});

await test("CLV-098 board surfaces, state cues, focus and narrow command wrapping use the design tokens", () => {
  for (const selector of [".column", ".card"]) {
    const declarations = rule(selector);
    assert.match(declarations, /border-radius: var\(--shape-radius\)/);
    assert.match(
      declarations,
      /inset 0 0 0 var\(--shape-border\) var\(--color-line\)/,
    );
    assert.match(declarations, /background: var\(--color-(surface|panel)\)/);
  }
  assert.match(
    rule(".card-step.active"),
    /color: var\(--color-accent-strong\)/,
  );
  assert.match(rule(".decision-mark"), /background: [^;]*var\(--warn-tint\)/);
  assert.match(rule(".column.stopped"), /var\(--bad-tint\)/);
  assert.match(rule(".stopped .card"), /var\(--bad-tint\)/);
  assert.match(rule(".stopped .column-name"), /color: var\(--color-bad\)/);
  assert.match(rule(".columns"), /overflow-x: scroll/);
  assert.match(rule(".command code"), /overflow-wrap: anywhere/);
  assert.match(rule(".command code"), /white-space: pre-wrap/);
  assert.match(
    rule(
      "a:focus-visible, button:focus-visible, summary:focus-visible, input:focus-visible, textarea:focus-visible",
    ),
    /outline: 3px solid var\(--color-accent\)/,
  );
  assert.match(
    rule(
      "a:focus-visible, button:focus-visible, summary:focus-visible, input:focus-visible, textarea:focus-visible",
    ),
    /0 0 0 6px var\(--color-code-background\)/,
  );
});

await test("CLV-098 phases are stations and activity, events and commands have always-dark windows and filled controls", () => {
  assert.match(rule(".phases"), /background: var\(--color-surface\)/);
  assert.match(rule(".phase .mark"), /border-radius: 50%/);
  assert.match(
    rule(".code-window"),
    /background: var\(--color-code-background\)/,
  );
  assert.match(rule(".code-head"), /background: var\(--color-code-header\)/);
  assert.match(
    rule(".code-window .bad, .code-window .item.error"),
    /color: #FF7B72/,
  );
  assert.match(rule("button"), /background: var\(--color-code-line\)/);
  assert.match(rule("button"), /color: var\(--color-code-text\)/);
});

await test("CLV-098 text and focus colors meet contrast in both themes, with composited tints", () => {
  assert.equal(contrast(rgb("#000000"), rgb("#FFFFFF")), 21);
  assert.equal(contrast(rgb("#123456"), rgb("#123456")), 1);
  for (const tokens of Object.values(palette)) {
    for (const background of [
      tokens["color-page"],
      tokens["color-surface"],
      tokens["color-panel"],
    ]) {
      for (const text of [
        tokens["color-ink"],
        tokens["color-muted"],
        tokens["color-accent-strong"],
        tokens["color-bad"],
        tokens["color-warn"],
      ])
        assert.ok(
          contrast(rgb(text), rgb(background)) >= 4.5,
          `${text} on ${background}`,
        );
    }
    for (const tint of ["accent-tint", "bad-tint"] as const) {
      const background = over(tokens[tint], rgb(tokens["color-surface"]));
      for (const text of [
        tokens["color-ink"],
        tokens["color-muted"],
        tokens["color-accent-strong"],
      ])
        assert.ok(contrast(rgb(text), background) >= 4.5, `${text} on ${tint}`);
    }
    assert.ok(
      contrast(
        rgb(tokens["color-warn"]),
        over(tokens["warn-tint"], rgb(tokens["color-surface"])),
      ) >= 4.5,
    );
  }
});

await test("CLV-098 dark code text and separated accent focus outlines meet contrast in either theme", () => {
  for (const tokens of Object.values(palette)) {
    for (const background of [
      tokens["color-code-background"],
      tokens["color-code-header"],
    ]) {
      for (const text of [
        tokens["color-code-text"],
        tokens["color-code-muted"],
        "#FF7B72",
        tokens["color-accent"],
      ])
        assert.ok(
          contrast(rgb(text), rgb(background)) >= 4.5,
          `${text} on ${background}`,
        );
    }
    assert.ok(
      contrast(
        rgb(tokens["color-accent"]),
        rgb(tokens["color-code-background"]),
      ) >= 3,
    );
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
    const stopped = over(tokens["bad-tint"], rgb(tokens["color-surface"]));
    const tag = layers.toReversed().reduce((base, token) => {
      assert.ok(token);
      const color = colors[token];
      assert.ok(color);
      return over(color, base);
    }, stopped);
    assert.ok(
      contrast(rgb(tokens["color-warn"]), tag) >= 4.5,
      `${tokens["color-warn"]} over stopped warning tag`,
    );
  }
});

await test("CLV-098 run tones retain green, warning, red and neutral cues and readable code text", () => {
  for (const selector of [
    ".working .icon, .phase.active .mark, .banner.working h2",
    ".good .icon, .phase.done .mark, p.good",
  ])
    assert.match(rule(selector), /color: var\(--color-accent-strong\)/);
  assert.match(rule(".attention .icon"), /color: var\(--color-warn\)/);
  assert.match(
    rule(".bad .icon, .phase.failed .mark, .bad, .down"),
    /color: var\(--color-bad\)/,
  );
  assert.match(rule(".icon"), /color: var\(--color-muted\)/);
  assert.match(rule(".banner"), /border-left: 6px solid var\(--color-muted\)/);
  assert.match(rule(".code-window"), /color: var\(--color-code-text\)/);
  assert.match(
    rule(".code-window summary, .code-window .event, .code-window .item.tool"),
    /color: var\(--color-code-muted\)/,
  );
  assert.match(
    rule(".code-window .item.result"),
    /color: var\(--color-accent\)/,
  );
  assert.match(rule("button"), /color: var\(--color-code-text\)/);
});

await test("CLV-135 add-card controls use readable theme colors and fields fit narrow columns", () => {
  assert.match(
    rule(".add-card, .add-card-form button"),
    /color: var\(--color-ink\)/,
  );
  assert.match(
    rule(".add-card-form input, .add-card-form textarea"),
    /width: 100%/,
  );
  assert.match(
    rule(".add-card-form input, .add-card-form textarea"),
    /color: var\(--color-ink\)/,
  );
  assert.match(
    rule(".add-card-form input, .add-card-form textarea"),
    /background: var\(--color-surface\)/,
  );
  assert.match(css, /input:focus-visible, textarea:focus-visible/);
});

function hoverBackground(selector: string): string {
  const own = [...rules.matchAll(/\n([^{}\n]+) \{([^}]*)\}/g)]
    .filter(([, selectors]) => selectors?.split(", ").includes(selector))
    .map(
      ([, , body]) => /background: var\(--([a-z0-9-]+)\)/.exec(body ?? "")?.[1],
    )
    .findLast((token) => token !== undefined);
  const general = /background: var\(--([a-z0-9-]+)\)/.exec(
    rule("button:hover"),
  )?.[1];
  const token = own ?? general;
  assert.ok(token !== undefined, selector);
  return token;
}

await test("CLV-135 add-card buttons keep readable text on hover in both themes", () => {
  for (const selector of [".add-card:hover", ".add-card-form button:hover"]) {
    const token = hoverBackground(selector);
    for (const [theme, tokens] of Object.entries(palette)) {
      const background: unknown = Reflect.get(tokens, token);
      assert.ok(typeof background === "string", `${selector} ${token}`);
      assert.ok(
        contrast(rgb(tokens["color-ink"]), rgb(background)) >= 4.5,
        `${selector} in the ${theme} theme: ink on ${token}`,
      );
    }
  }
});

function media(width: number): string {
  const start = css.indexOf(`@media (max-width: ${String(width)}px) {`);
  assert.ok(start >= 0, String(width));
  return css.slice(start, css.indexOf("\n}", start));
}

await test("CLV-286 buttons and run tokens are filled rectangles with angled corners", () => {
  assert.match(
    rule(":root"),
    /--angled: polygon\(var\(--shape-cut\) 0, 100% 0, 100% calc\(100% - var\(--shape-cut\)\), calc\(100% - var\(--shape-cut\)\) 100%, 0 100%, 0 var\(--shape-cut\)\);/,
  );
  for (const selector of ["button", ".token"]) {
    assert.match(rule(selector), /clip-path: var\(--angled\)/);
    assert.match(rule(selector), /background: (var|color-mix)\(/);
    assert.doesNotMatch(
      rule(selector),
      /background: transparent|border-radius: [1-9]/,
    );
  }
  assert.match(
    rule("button:focus-visible, .token:focus-visible"),
    /clip-path: none/,
  );
});

await test("CLV-286 stations have a fixed width on a rail, and narrow screens move the side panels and stack each line", () => {
  assert.match(rule(".stations"), /display: flex/);
  assert.match(rule(".stations"), /justify-content: flex-start/);
  assert.match(rule(".station"), /flex: 0 0 var\(--station-width\)/);
  assert.match(rule(".station:not(:last-child)::after"), /width: 100%/);
  assert.match(rule(".line-track"), /overflow-x: auto/);
  assert.match(
    rule(".floor-layout"),
    /grid-template-columns: minmax\(0, 1fr\) minmax\(260px, 340px\)/,
  );
  assert.match(
    media(1100),
    /\.floor-layout \{ grid-template-columns: minmax\(0, 1fr\); \}/,
  );
  assert.match(
    media(720),
    /\.line \{ grid-template-columns: minmax\(0, 1fr\); \}/,
  );
});

await test("CLV-289 the Today panel is a surface like the floor, the bar of today stands out and the lane marks are angled", () => {
  assert.match(rule(".today"), /background: var\(--color-surface\)/);
  assert.match(
    rule(".today"),
    /box-shadow: inset 0 0 0 var\(--shape-border\) var\(--color-line\)/,
  );
  assert.match(
    rule(".today-numbers"),
    /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/,
  );
  assert.match(rule(".today-chart text"), /text-anchor: middle/);
  assert.match(
    rule(".today-bar rect"),
    /fill: color-mix\(in srgb, var\(--color-state-completed\) 40%, var\(--color-surface\)\)/,
  );
  assert.match(
    rule(".today-bar.current rect"),
    /fill: var\(--color-state-completed\)/,
  );
  assert.match(rule(".lane"), /clip-path: var\(--angled\)/);
  assert.match(rule(".lane.busy"), /background: var\(--color-state-running\)/);
  assert.match(rule(".lane.free"), /background: var\(--color-line\)/);
});
