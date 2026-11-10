import assert from "node:assert/strict";
import { test } from "node:test";
import { rule } from "./watch-style-fixture.ts";

await test("CLV-340 the loop cell of a floor line stacks its lines at the right edge, colors the state and the failures, and its Run now button waits while it posts", () => {
  assert.throws(() => rule(".loops"));
  assert.throws(() => rule(".loops-list"));
  assert.match(
    rule(".line"),
    /grid-template-columns: 180px minmax\(0, 1fr\) 240px/,
  );
  assert.match(
    rule(".line-loop"),
    /display: flex; flex-direction: column; align-items: flex-end/,
  );
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
  assert.match(
    rule(".line-loop p.loop-failures"),
    /color: var\(--color-state-failed\)/,
  );
  assert.match(
    rule(".loop-actions"),
    /display: flex; align-items: center; justify-content: flex-end/,
  );
  assert.match(rule(".loop-switch"), /display: inline-flex/);
  assert.match(rule(".loop-run"), /border: 0; cursor: pointer/);
  assert.match(rule(".loop-run:disabled"), /cursor: progress; opacity: 0.6/);
  assert.match(rule(".line-loop p.loop-message"), /color: var\(--color-ink\)/);
});
