import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { component } from "../src/cli/watch-element.ts";
import type { WatchModel } from "../src/cli/watch-render.ts";
import { shownTheme } from "../src/cli/watch-theme-view.ts";
import type { WatchTheme } from "../src/cli/watch-themes.ts";
import { Page } from "../src/cli/watch-view.ts";
import { rendered } from "./watch-dom.ts";
import { at, noCopy, sampleModel, sampleRun } from "./watch-sample.ts";

const model = sampleModel([sampleRun()]);

const workshop: WatchTheme = {
  name: "workshop",
  title: "Workshop",
  colorScheme: "light",
  usable: true,
  codes: [],
  classes: [],
  words: { "workflows.title": "Shop floor" },
};

function page(
  shown: WatchModel,
  options: { readonly selected: string; readonly theme?: WatchTheme },
): string {
  const themes = {
    setting: options.theme?.name ?? "auto",
    style: "",
    themes: options.theme === undefined ? [] : [options.theme],
    failure: null,
  };
  return rendered(
    component(Page, {
      model: shown,
      selected: options.selected,
      now: at("21:34:41"),
      stale: false,
      copying: noCopy,
      theme: {
        shown: shownTheme(themes, { choice: null, dark: false }),
        themes: themes.themes,
        onChoose: () => undefined,
      },
    }),
  );
}

function banner(html: string): string {
  const start = html.indexOf('<section class="banner');
  assert.ok(start >= 0, html);
  return html.slice(start, html.indexOf("</section>", start));
}

await test("CLV-342 the first item of the run banner is a back link to the floor, with the theme word for the floor title", () => {
  assert.match(
    banner(page(model, { selected: "#run=run-1" })),
    /^<section class="banner attention"><a class="banner-back" href="#">← Floor<\/a><span class="icon">!<\/span>/,
  );
  assert.match(
    banner(page(model, { selected: "#run=run-1", theme: workshop })),
    /^<section class="banner attention"><a class="banner-back" href="#">← Shop floor<\/a><span class="icon">/,
  );
});

await test("CLV-342 a run opened from a board has a back link to that board in its banner", () => {
  assert.match(
    banner(page(model, { selected: "#workflow=develop-ticket&run=run-1" })),
    /^<section class="banner attention"><a class="banner-back" href="#workflow=develop-ticket">← develop-ticket<\/a><span class="icon">/,
  );
});

await test("CLV-342 the run detail page has one back link, the link in the banner", () => {
  for (const selected of ["#run=run-1", "#workflow=develop-ticket&run=run-1"]) {
    const html = page(model, { selected });
    assert.doesNotMatch(html, /← Back to|class="back"/);
    assert.equal(html.match(/class="banner-back"/g)?.length, 1);
  }
});

await test("CLV-342 the README describes the back link in the run banner", async () => {
  const readme = await readFile("README.md", "utf8");
  assert.match(
    readme,
    /The banner stays at the top of the window when you scroll the run\. The first item of the banner is a back link\. From the floor, the link shows `← Floor` and opens the floor\. When the theme gives a word for the floor title, the link shows that word\. From a board, the link shows `← <workflowId>` and opens that board\. In a workspace, the link keeps the repository of the board\./,
  );
});
