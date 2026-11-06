import assert from "node:assert/strict";
import { test } from "node:test";
import { serviceOf } from "../src/cli/restart-render.ts";
import { component } from "../src/cli/watch-element.ts";
import { Header } from "../src/cli/watch-view.ts";
import { boardModel } from "./watch-board-fixture.ts";
import { rendered } from "./watch-dom.ts";

await test("CLV-306 the watch page shows a pending restart with the active runs", () => {
  const restart = {
    at: "gap",
    requestedAt: 1,
    commandId: "one",
    activeRuns: 2,
  };
  const model = boardModel([], serviceOf({ serviceVersion: "1.6.0", restart }));
  const html = rendered(component(Header, { model, stale: false }));
  assert.ok(
    html.includes(
      '<span class="restart-pending">Restart pending: 2 runs active</span>',
    ),
    html,
  );
  assert.ok(html.includes('<div class="version">cloving 1.6.0</div>'), html);
});

await test("CLV-306 the watch page shows no restart line when no restart is pending", () => {
  const model = boardModel([], serviceOf({ restart: null }));
  assert.deepEqual(serviceOf({ restart: null, serviceVersion: 7 }), {});
  const html = rendered(component(Header, { model, stale: false }));
  assert.doesNotMatch(html, /restart-pending/);
});
