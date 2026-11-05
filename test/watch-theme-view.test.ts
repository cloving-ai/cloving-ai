import assert from "node:assert/strict";
import { test } from "node:test";
import { component } from "../src/cli/watch-element.ts";
import type { WatchCard, WatchModel } from "../src/cli/watch-render.ts";
import {
  countText,
  shownTheme,
  type ThemeControls,
} from "../src/cli/watch-theme-view.ts";
import type { WatchTheme, WatchThemes } from "../src/cli/watch-themes.ts";
import { Page } from "../src/cli/watch-view.ts";
import { activeBoardModel } from "./watch-board-fixture.ts";
import { found, rendered } from "./watch-dom.ts";
import { twoLineModel } from "./watch-floor-fixture.ts";
import { noCopy } from "./watch-sample.ts";
import { shelfModel } from "./watch-shelf-fixture.ts";

const workshop: WatchTheme = {
  name: "workshop",
  title: "Workshop",
  colorScheme: "light",
  usable: true,
  codes: [],
  classes: ["art-station"],
  words: {
    "workflows.title": "Shop floor",
    "station.agent": "Bench",
    "station.review": "Inspector",
    "column.done": "Shipped",
    "column.stopped": "Scrap",
    "state.attention": "Help desk",
    "state.decision": "Bulletin board",
    "totals.label": "Bill",
    "completed.unit": { one: "shoe", other: "shoes" },
    "ticket.unit": { one: "{count} order", other: "{count} orders" },
  },
};
const broken: WatchTheme = {
  name: "broken",
  title: "Broken",
  colorScheme: "light",
  usable: false,
  codes: ["invalid-color", "missing-asset"],
  classes: [],
  words: {},
};
const light: WatchTheme = {
  ...workshop,
  name: "light",
  title: null,
  classes: [],
  words: {},
};
const dark: WatchTheme = { ...light, name: "dark", colorScheme: "dark" };

function listed(setting: string, themes: readonly WatchTheme[]): WatchThemes {
  return { setting, style: "", themes, failure: null };
}

function controls(
  choice: string | null,
  changes: { readonly chosen?: string[] } = {},
): ThemeControls {
  const themes = listed("workshop", [broken, dark, light, workshop]);
  return {
    shown: shownTheme(themes, { choice, dark: false }),
    themes: themes.themes,
    onChoose: (name) => {
      changes.chosen?.push(name);
    },
  };
}

function page(
  model: WatchModel,
  options: { readonly selected?: string; readonly theme?: ThemeControls } = {},
): string {
  return rendered(
    component(Page, {
      model,
      selected: options.selected ?? "",
      now: model.updatedAt,
      stale: false,
      copying: noCopy,
      theme: options.theme ?? controls(null),
    }),
  );
}

await test("CLV-291 the shown theme is the choice of the browser, else watch.theme, and auto follows the color scheme", () => {
  const themes = listed("workshop", [broken, dark, light, workshop]);
  for (const [choice, scheme, name] of [
    [null, false, "workshop"],
    ["light", false, "light"],
    ["auto", false, "light"],
    ["auto", true, "dark"],
  ] as const) {
    const shown = shownTheme(themes, { choice, dark: scheme });
    assert.equal(shown.theme?.name, name, String(choice));
    assert.equal(shown.choice, choice ?? "workshop");
    assert.equal(shown.notice, null);
  }
});

await test("CLV-291 a refused or missing selected theme gives the default theme and a notice with the reason", () => {
  const themes = listed("broken", [broken, light, workshop]);
  assert.deepEqual(shownTheme(themes, { choice: null, dark: false }), {
    choice: "broken",
    theme: null,
    notice:
      "The page uses the default theme: the theme broken is refused: invalid-color, missing-asset.",
  });
  assert.deepEqual(shownTheme(themes, { choice: "gone", dark: false }), {
    choice: "gone",
    theme: null,
    notice:
      "The page uses the default theme: no theme folder has the name gone.",
  });
  assert.deepEqual(shownTheme(themes, { choice: "auto", dark: true }), {
    choice: "auto",
    theme: null,
    notice: null,
  });
  assert.equal(
    shownTheme(
      { ...listed("workshop", []), failure: "unreadable-theme-folder: denied" },
      { choice: null, dark: false },
    ).notice,
    "The page uses the default theme: unreadable-theme-folder: denied.",
  );
});

await test("CLV-291 the header has a theme menu with Auto and each usable theme, and a choice goes to the page", () => {
  const chosen: string[] = [];
  const shown = component(Page, {
    model: twoLineModel(),
    selected: "",
    now: twoLineModel().updatedAt,
    stale: false,
    copying: noCopy,
    theme: controls("light", { chosen }),
  });
  const html = rendered(shown);
  assert.match(
    html,
    /<label class="theme-menu">Theme <select[^>]*><option value="auto">Auto<\/option><option value="dark">dark<\/option><option value="light">light<\/option><option value="workshop">Workshop<\/option><\/select><\/label>/,
  );
  const menu = found(shown, "select")[0] ?? {};
  assert.equal(menu["value"], "light");
  const change: unknown = menu["onChange"];
  assert.ok(typeof change === "function");
  Reflect.apply(change, undefined, [{ currentTarget: { value: "workshop" } }]);
  assert.deepEqual(chosen, ["workshop"]);
  assert.doesNotMatch(html, /theme-notice/);
});

await test("CLV-291 the header shows the notice of a refused selected theme", () => {
  const html = page(twoLineModel(), { theme: controls("broken") });
  assert.match(
    html,
    /<p class="theme-notice" role="status">The page uses the default theme: the theme broken is refused: invalid-color, missing-asset\.<\/p>/,
  );
  assert.doesNotMatch(html, /Shop floor/);
});

await test("CLV-291 the floor and the shelf use the words of the theme with its plural forms", () => {
  const html = page(twoLineModel());
  assert.match(html, /<h2 id="floor-title">Shop floor<\/h2>/);
  assert.match(html, /<span class="station-name">Bench<\/span>/);
  assert.doesNotMatch(html, /Agent turn/);
  const shelf = shelfModel();
  assert.match(page(shelf), /<span class="shelf-count">3 shoes<\/span>/);
  assert.match(
    page({ ...shelf, completed: (shelf.completed ?? []).slice(0, 1) }),
    /<span class="shelf-count">1 shoe<\/span>/,
  );
  assert.match(
    page(shelf, { theme: controls("light") }),
    /<span class="shelf-count">3 runs<\/span>/,
  );
});

await test("CLV-291 a plural form with {count} puts the count in its place, and run.unit counts runs when completed.unit is not set", () => {
  const words = { "ticket.unit": workshop.words["ticket.unit"] ?? "" };
  assert.equal(
    countText(words, { key: "ticket.unit", count: 1, noun: "ticket" }),
    "1 order",
  );
  assert.equal(
    countText(words, { key: "ticket.unit", count: 2, noun: "ticket" }),
    "2 orders",
  );
  assert.equal(
    countText({}, { key: "ticket.unit", count: 2, noun: "ticket" }),
    "2 tickets",
  );
  const shelf = shelfModel();
  const runs = controls("workshop");
  const shown = runs.shown.theme;
  assert.ok(shown !== null);
  const html = page(shelf, {
    theme: {
      ...runs,
      shown: {
        ...runs.shown,
        theme: {
          ...shown,
          words: { "run.unit": { one: "job", other: "jobs" } },
        },
      },
    },
  });
  assert.match(html, /<span class="shelf-count">3 jobs<\/span>/);
});

await test("CLV-291 the queue counts skipped tickets with the ticket word of the theme", () => {
  const model: WatchModel = {
    ...twoLineModel(),
    queue: {
      skipped: [
        { ticketId: "1", reason: "ticket-active" },
        { ticketId: "2", reason: "ticket-active" },
      ],
    },
  };
  assert.match(page(model), /<summary>2 orders skipped<\/summary>/);
});

function boardCard(): WatchCard {
  return {
    completionMark: null,
    pullRequestObservation: null,
    runId: "run-1",
    title: "Review the change",
    claudeCostUsd: 1.236,
    estimatedCostUsd: null,
    usage: {
      input_tokens: null,
      cache_read_input_tokens: null,
      output_tokens: null,
    },
    currentStep: null,
    endedAt: null,
    decisionWaiting: true,
    round: null,
    greptileScore: null,
    pullRequestNumber: null,
  };
}

await test("CLV-291 the board shows the column, mark and totals words of the theme and keeps the column names as keys", () => {
  const model = activeBoardModel();
  const card = boardCard();
  const attention = {
    ...card,
    runId: "run-2",
    completionMark: { text: "Needs attention", laterRunId: null },
  };
  const board: WatchModel = {
    ...model,
    workflows: model.workflows.map((workflow) => ({
      ...workflow,
      columns: [
        { name: "Agent turn", cards: [card] },
        { name: "Your review", cards: [] },
        { name: "Done", cards: [attention] },
        { name: "Stopped", cards: [] },
      ],
    })),
  };
  const workflowId = model.workflows[0]?.workflowId ?? "";
  const html = page(board, { selected: `workflow=${workflowId}` });
  for (const text of [
    '<span>Bench</span> <span class="column-count">1</span>',
    '<span>Inspector</span> <span class="column-count">0</span>',
    'aria-label="Expand Shipped"',
    '<section class="column stopped collapsed"',
    'aria-label="Expand Scrap"',
    "Bill · 1.24 USD",
    "! Bulletin board",
  ])
    assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /Decision waiting|Totals|>Done<|>Stopped</);
  const opened = page(board, {
    selected: `workflow=${workflowId}`,
    theme: controls("workshop"),
  });
  assert.ok(opened.includes("Bench"));
});

await test("CLV-291 the theme menu shows a selected theme that is not usable as a disabled choice", () => {
  const html = page(twoLineModel(), { theme: controls("gone") });
  assert.match(
    html,
    /<option value="workshop">Workshop<\/option><option value="gone" disabled>gone \(not usable\)<\/option><\/select>/,
  );
  assert.doesNotMatch(
    page(twoLineModel(), { theme: controls("broken") }),
    /<option value="broken">/,
  );
});
