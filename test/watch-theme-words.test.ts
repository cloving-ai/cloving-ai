import assert from "node:assert/strict";
import { test } from "node:test";
import { component } from "../src/cli/watch-element.ts";
import type { WatchModel } from "../src/cli/watch-render.ts";
import { shownTheme } from "../src/cli/watch-theme-view.ts";
import type { WatchTheme } from "../src/cli/watch-themes.ts";
import { Page } from "../src/cli/watch-view.ts";
import { rendered } from "./watch-dom.ts";
import { noCopy } from "./watch-sample.ts";
import { workshopModel } from "./watch-workshop-fixture.ts";

const worded: WatchTheme = {
  name: "workshop",
  title: "Workshop",
  colorScheme: "light",
  usable: true,
  codes: [],
  classes: [],
  words: {
    "today.title": "Bulletin board",
    "needs.title": "Inspector",
    "ready.count": { one: "Help desk: {count}", other: "Help desk: {count}" },
  },
};

function page(model: WatchModel, themes: readonly WatchTheme[]): string {
  const listed = { setting: "workshop", style: "", themes, failure: null };
  return rendered(
    component(Page, {
      model,
      selected: "",
      now: model.updatedAt,
      stale: false,
      copying: noCopy,
      theme: {
        shown: shownTheme(listed, { choice: null, dark: false }),
        themes,
        onChoose: () => undefined,
      },
    }),
  );
}

await test("CLV-292 the Today heading, the Needs you heading and the ready count use the words of the theme", () => {
  const html = page(workshopModel(), [worded]);
  assert.match(html, /<h2 id="today-title">Bulletin board<\/h2>/);
  assert.match(html, /<h2 id="needs-title">Inspector<\/h2>/);
  assert.match(html, /<span class="line-ready">Help desk: 3<\/span>/);
  assert.doesNotMatch(html, />Today<|>Needs you<\/h2>|3 ready/);
});

await test("CLV-292 with no theme words the panels keep Today, Needs you and the ready count", () => {
  const html = page(workshopModel(), [{ ...worded, words: {} }]);
  assert.match(html, /<h2 id="today-title">Today<\/h2>/);
  assert.match(html, /<h2 id="needs-title">Needs you<\/h2>/);
  assert.match(html, /<span class="line-ready">3 ready<\/span>/);
  const one = workshopModel();
  const single = {
    ...one,
    workflows: one.workflows.map((workflow) => ({
      ...workflow,
      ready: { count: 1, oldestAt: null },
    })),
  };
  assert.match(page(single, [worded]), /Help desk: 1/);
  assert.match(
    page(single, [{ ...worded, words: {} }]),
    /<span class="line-ready">1 ready<\/span>/,
  );
});
