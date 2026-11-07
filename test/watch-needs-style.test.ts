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

await test("CLV-307 the Continue button of a stopped run has no border, waits while it posts, and its reply shows under the run", () => {
  assert.match(rule(".need-action"), /border: 0; cursor: pointer/);
  assert.match(rule(".need-action:disabled"), /cursor: progress; opacity: 0.6/);
  assert.match(rule(".need-message"), /margin: 4px 0 0; font-size: 13px/);
});

await test("CLV-321 the count of runs with no cost is a small muted line under the spend", () => {
  assert.match(rule(".today-unknown"), /color: var\(--color-muted\)/);
  assert.match(rule(".today-unknown"), /font-size: 12px/);
});
