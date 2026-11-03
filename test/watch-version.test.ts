import assert from "node:assert/strict";
import { test } from "node:test";
import { component } from "../src/cli/watch-element.ts";
import { Header } from "../src/cli/watch-view.ts";
import { boardModel } from "./watch-board-fixture.ts";
import { rendered } from "./watch-dom.ts";

await test("the watch page shows the version that the service reports", () => {
  const model = boardModel([], { serviceVersion: "9.8.7" });
  const html = rendered(component(Header, { model, stale: false }));
  assert.ok(html.includes('<div class="version">cloving 9.8.7</div>'), html);
});

await test("the watch page shows no version before the service reports one", () => {
  const html = rendered(
    component(Header, { model: boardModel([]), stale: false }),
  );
  assert.doesNotMatch(html, /class="version"/);
  const waiting = rendered(component(Header, { model: null, stale: false }));
  assert.doesNotMatch(waiting, /class="version"/);
});
