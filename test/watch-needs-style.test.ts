import assert from "node:assert/strict";
import { test } from "node:test";
import { contrast, palette, rgb, rule } from "./watch-style-fixture.ts";

await test("CLV-287 the Needs you panel sits under the floor, marks a decision blue and a stopped run red, and fills its action buttons", () => {
  assert.match(rule(".floor-main"), /display: flex; flex-direction: column/);
  assert.match(
    rule(".need-decision"),
    /--mark: var\(--color-state-attention\)/,
  );
  assert.match(rule(".need-stopped"), /--mark: var\(--color-state-failed\)/);
  assert.match(rule(".need-mark"), /background: var\(--mark\)/);
  assert.match(rule(".need-mark"), /align-self: stretch/);
  assert.match(rule(".need-action"), /clip-path: var\(--angled\)/);
  assert.match(rule(".need-action"), /background: var\(--color-panel\)/);
  assert.match(rule(".need-action"), /color: var\(--color-ink\)/);
  assert.match(
    rule(".need-decision .need-action"),
    /background: var\(--color-state-attention\); color: var\(--on-lamp\)/,
  );
  assert.match(rule(".need-action:focus-visible"), /clip-path: none/);
  const defaults = rule(":root");
  const color = (name: string): string =>
    new RegExp(`--${name}: (#[0-9A-F]{6});`).exec(defaults)?.[1] ?? "";
  assert.ok(
    contrast(rgb(color("on-lamp")), rgb(color("color-state-attention"))) >= 4.5,
  );
  for (const tokens of Object.values(palette))
    assert.ok(
      contrast(rgb(tokens["color-ink"]), rgb(tokens["color-panel"])) >= 4.5,
    );
});
