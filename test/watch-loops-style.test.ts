import assert from "node:assert/strict";
import { test } from "node:test";
import { rule } from "./watch-style-fixture.ts";

await test("CLV-328 the Loops panel is a side panel whose rows color the state, and whose Run now button waits while it posts", () => {
  assert.match(rule(".loops"), /background: var\(--color-surface\)/);
  assert.match(rule(".loops-list"), /list-style: none; margin: 0; padding: 0/);
  assert.match(rule(".loop"), /border-bottom: var\(--shape-border\) solid/);
  assert.match(
    rule(".loop-active .loop-state"),
    /color: var\(--color-state-running\)/,
  );
  assert.match(
    rule(".loop-paused .loop-state"),
    /color: var\(--color-state-waiting\)/,
  );
  assert.match(
    rule(".loop-stopped .loop-state"),
    /color: var\(--color-state-failed\)/,
  );
  assert.match(rule(".loop-actions"), /display: flex; align-items: center/);
  assert.match(rule(".loop-switch"), /display: inline-flex/);
  assert.match(rule(".loop-run"), /border: 0; cursor: pointer/);
  assert.match(rule(".loop-run:disabled"), /cursor: progress; opacity: 0.6/);
  assert.match(rule(".loop p.loop-message"), /color: var\(--color-ink\)/);
});
