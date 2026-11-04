import assert from "node:assert/strict";
import { test } from "node:test";
import { contrast, palette, rgb, rule } from "./watch-style-fixture.ts";

await test("CLV-287 the Needs you panel sits under the floor, marks a decision blue and a stopped run red, and fills its action buttons", () => {
  assert.match(rule(".floor-main"), /display: flex; flex-direction: column/);
  assert.match(rule(".need-decision"), /--mark: var\(--needs-you\)/);
  assert.match(rule(".need-stopped"), /--mark: var\(--stopped\)/);
  assert.match(rule(".need-mark"), /background: var\(--mark\)/);
  assert.match(rule(".need-mark"), /align-self: stretch/);
  assert.match(rule(".need-action"), /clip-path: var\(--angled\)/);
  assert.match(rule(".need-action"), /background: var\(--surface-2\)/);
  assert.match(rule(".need-action"), /color: var\(--ink\)/);
  assert.match(
    rule(".need-decision .need-action"),
    /background: var\(--needs-you\); color: var\(--on-lamp\)/,
  );
  assert.match(rule(".need-action:focus-visible"), /clip-path: none/);
  const defaults = rule(":root");
  const color = (name: string): string =>
    new RegExp(`--${name}: (#[0-9A-F]{6});`).exec(defaults)?.[1] ?? "";
  assert.ok(contrast(rgb(color("on-lamp")), rgb(color("needs-you"))) >= 4.5);
  for (const tokens of Object.values(palette))
    assert.ok(contrast(rgb(tokens.ink), rgb(tokens["surface-2"])) >= 4.5);
});
