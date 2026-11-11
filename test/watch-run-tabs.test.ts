import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { component, type Shown } from "../src/cli/watch-element.ts";
import type { WatchTurn } from "../src/cli/watch-render.ts";
import {
  type RunTab,
  type TranscriptControls,
} from "../src/cli/watch-transcript-view.ts";
import { RunTurns } from "../src/cli/watch-run-tabs-view.ts";
import { played } from "./watch-browser.ts";
import { found, rendered } from "./watch-dom.ts";
import { rule } from "./watch-style-fixture.ts";
import {
  at,
  sampleModel,
  sampleRun,
  sampleTurn,
  wantedTranscripts,
} from "./watch-sample.ts";

const turns: readonly WatchTurn[] = [
  sampleTurn({
    key: "k1",
    operationId: "operation-1",
    outcome: "completed",
    startedAt: at("21:20:00"),
    endedAt: at("21:30:00"),
    costUsd: 1.5,
  }),
  sampleTurn({
    key: "k2",
    operationId: "operation-2",
    outcome: "in work",
    startedAt: at("21:31:00"),
  }),
];

const run = sampleRun({
  state: "running",
  turns,
  feedback: [{ decisionId: "run-1/review-1", text: "Fix the name." }],
});

function tabbed(transcripts: TranscriptControls | undefined): Shown {
  return component(RunTurns, {
    run,
    now: at("21:40:00"),
    transcripts,
    turnId: null,
  });
}

function controls(tab: RunTab, chosen: RunTab[]): TranscriptControls {
  return {
    ...wantedTranscripts,
    tab,
    onTab: (next) => {
      chosen.push(next);
    },
  };
}

function panels(shown: Shown) {
  return found(shown, "div")
    .filter((node) => node["role"] === "tabpanel")
    .map((node) => [node["id"], node["aria-labelledby"], node["hidden"]]);
}

const unselected = [
  ["Events (2)", "false"],
  ["Details", "false"],
];

const closed = [
  ["run-panel-events", "run-tab-events", true],
  ["run-panel-details", "run-tab-details", true],
];

function tabs(shown: Shown) {
  return found(shown, "button").filter((node) => node["role"] === "tab");
}

function part(html: string, id: string): string {
  const start = html.indexOf(`id="${id}"`);
  const end = html.indexOf('role="tabpanel"', start + 1);
  return html.slice(start, end < 0 ? html.length : end);
}

await test("CLV-341 CLV-357 the turns of a run have one tab bar with Transcript selected, and the transcript heads name their turns", () => {
  const shown = tabbed(controls("transcript", []));
  const html = rendered(shown);
  assert.match(
    html,
    /<div class="run-tabs" role="tablist" aria-label="Run views"><button type="button" role="tab" id="run-tab-transcript" aria-selected="true" aria-controls="run-panel-transcript" class="run-tab">Transcript<\/button><button type="button" role="tab" id="run-tab-pull" aria-selected="false" aria-controls="run-panel-pull" class="run-tab">Pull request<\/button><button type="button" role="tab" id="run-tab-events" aria-selected="false" aria-controls="run-panel-events" class="run-tab">Events \(2\)<\/button><button type="button" role="tab" id="run-tab-details" aria-selected="false" aria-controls="run-panel-details" class="run-tab">Details<\/button><\/div>/,
  );
  assert.deepEqual(panels(shown), [
    ["run-panel-transcript", "run-tab-transcript", false],
    ["run-panel-pull", "run-tab-pull", true],
    ...closed,
  ]);
  const transcript = part(html, "run-panel-transcript");
  assert.deepEqual(
    [...transcript.matchAll(/<div class="code-head">([^<]*) <button/g)].map(
      (match) => match[1],
    ),
    [
      "Turn 1 · completed · 10 min 0 s · 1.50 USD",
      "Turn 2 · in work · 9 min 0 s · Price not known",
    ],
  );
  assert.doesNotMatch(html, /class="turn code-window"|run-panel-turn/);
});

await test("CLV-341 CLV-357 a click on a tab asks for that tab, and the Pull request tab hides the transcripts", () => {
  const chosen: RunTab[] = [];
  const shown = tabbed(controls("pull", chosen));
  assert.deepEqual(
    tabs(shown).map((tab) => [tab["children"], tab["aria-selected"]]),
    [["Transcript", "false"], ["Pull request", "true"], ...unselected],
  );
  assert.deepEqual(panels(shown), [
    ["run-panel-transcript", "run-tab-transcript", true],
    ["run-panel-pull", "run-tab-pull", false],
    ...closed,
  ]);
  for (const tab of tabs(shown)) {
    assert.ok(typeof tab["onClick"] === "function");
    Reflect.apply(tab["onClick"], undefined, []);
  }
  assert.deepEqual(chosen, ["transcript", "pull", "events", "details"]);
});

await test("CLV-341 CLV-357 the code review of a round shows under its turn in the Transcript tab", () => {
  const html = rendered(tabbed(controls("transcript", [])));
  assert.equal(
    [
      ...part(html, "run-panel-transcript").matchAll(
        /<section class="review denied">/g,
      ),
    ].length,
    1,
  );
});

await test("CLV-341 with no transcript controls, the Transcript tab is selected and a click changes nothing", () => {
  const shown = tabbed(undefined);
  assert.deepEqual(panels(shown), [
    ["run-panel-transcript", "run-tab-transcript", false],
    ["run-panel-pull", "run-tab-pull", true],
    ...closed,
  ]);
  for (const tab of tabs(shown)) {
    assert.ok(typeof tab["onClick"] === "function");
    Reflect.apply(tab["onClick"], undefined, []);
  }
  assert.deepEqual(panels(tabbed(undefined)), panels(shown));
});

await test("CLV-341 the page keeps the selected tab through a refresh, and a link with a turn selects the Transcript tab again", () => {
  const result = played(
    sampleModel([run]),
    `
const model = JSON.parse(process.env.WATCH_MODEL);
globalThis.EventSource = class {
  constructor() { this.readyState = 1; }
  addEventListener() {}
  close() { this.readyState = 2; }
};
const tabs = () => app.all("button").filter((node) => node.getAttribute("role") === "tab").map((node) => [node.text, node.getAttribute("aria-selected")]);
const hidden = () => app.all("div").filter((node) => node.getAttribute("role") === "tabpanel").map((node) => node.getAttribute("hidden"));
location.hash = "#run=run-1";
replies.push(model);
await load();
await settled();
const first = { tabs: tabs(), hidden: hidden() };
app.all("button").find((node) => node.text === "Pull request").dispatch("click");
await settled();
const clicked = { tabs: tabs(), hidden: hidden() };
replies.push(model);
await load();
await settled();
const refreshed = tabs();
location.hash = "#run=run-1&turn=operation-1";
replies.push(model);
listeners.hashchange();
await settled();
await new Promise((settle) => { setTimeout(settle, 80); });
console.log(JSON.stringify({ first, clicked, refreshed, linked: tabs() }));
`,
  );
  assert.deepEqual(result, {
    first: {
      tabs: [["Transcript", "true"], ["Pull request", "false"], ...unselected],
      hidden: [null, "true", "true", "true"],
    },
    clicked: {
      tabs: [["Transcript", "false"], ["Pull request", "true"], ...unselected],
      hidden: ["true", null, "true", "true"],
    },
    refreshed: [
      ["Transcript", "false"],
      ["Pull request", "true"],
      ...unselected,
    ],
    linked: [["Transcript", "true"], ["Pull request", "false"], ...unselected],
  });
});

await test("CLV-341 the tabs underline the selected tab, and a folded tool output shows its fold line as one row in the color of its result and opens under the gutter", () => {
  assert.match(
    rule(".run-tabs"),
    /display: flex;.*border-bottom: var\(--shape-border\) solid var\(--color-line\)/,
  );
  assert.match(rule(".run-tabs .run-tab"), /background: none; clip-path: none/);
  assert.match(
    rule('.run-tabs .run-tab[aria-selected="true"]'),
    /color: var\(--color-ink\); border-bottom-color: var\(--color-accent-strong\)/,
  );
  assert.match(rule(".transcript-lines details.tool-result"), /display: block/);
  assert.match(
    rule(".transcript-lines details.tool-result > summary"),
    /display: flex; color: inherit/,
  );
  assert.match(
    rule(".transcript-lines details.tool-result > .output"),
    /margin: 2px 0 0 3ch/,
  );
});

await test("CLV-341 CLV-357 the README describes the tabs of the run detail and the folded tool outputs", async () => {
  const readme = await readFile(
    new URL("../README.md", import.meta.url),
    "utf8",
  );
  assert.match(
    readme,
    /The run detail has one tab bar, with the tabs \*\*Transcript\*\*, \*\*Pull request\*\*, \*\*Events\*\* and \*\*Details\*\*\. \*\*Transcript\*\* is selected by default\./,
  );
  assert.match(
    readme,
    /`tool-result`: the output of a tool\. The view folds it/,
  );
  assert.match(readme, /`⎿ Error · N lines`/);
  assert.doesNotMatch(
    readme,
    /with the first 4 lines\. `… \+N lines` opens the rest/,
  );
});
