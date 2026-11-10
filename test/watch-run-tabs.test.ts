import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { component } from "../src/cli/watch-element.ts";
import type { WatchTurn } from "../src/cli/watch-render.ts";
import {
  RunTurns,
  type RunTab,
  type TranscriptControls,
} from "../src/cli/watch-transcript-view.ts";
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

function tabbed(
  transcripts: TranscriptControls | undefined,
): ReturnType<typeof component> {
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

function panels(shown: unknown): readonly (readonly unknown[])[] {
  return found(shown, "div")
    .filter((node) => node["role"] === "tabpanel")
    .map((node) => [node["id"], node["aria-labelledby"], node["hidden"]]);
}

function tabs(shown: unknown): readonly Record<string, unknown>[] {
  return found(shown, "button").filter((node) => node["role"] === "tab");
}

function part(html: string, id: string): string {
  const start = html.indexOf(`id="${id}"`);
  const end = html.indexOf('role="tabpanel"', start + 1);
  return html.slice(start, end < 0 ? html.length : end);
}

await test("CLV-341 the turns of a run have one tab bar with Transcript selected, the transcript heads name their turns, and the Agent turn detail is hidden", () => {
  const shown = tabbed(controls("transcript", []));
  const html = rendered(shown);
  assert.match(
    html,
    /<div class="run-tabs" role="tablist" aria-label="Turn views"><button type="button" role="tab" id="run-tab-transcript" aria-selected="true" aria-controls="run-panel-transcript" class="run-tab">Transcript<\/button><button type="button" role="tab" id="run-tab-turn" aria-selected="false" aria-controls="run-panel-turn" class="run-tab">Agent turn<\/button><\/div>/,
  );
  assert.deepEqual(panels(shown), [
    ["run-panel-transcript", "run-tab-transcript", false],
    ["run-panel-turn", "run-tab-turn", true],
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
  assert.doesNotMatch(transcript, /class="turn code-window"/);
  assert.match(
    part(html, "run-panel-turn"),
    /<h3 class="code-head">Agent turn · completed · 10 min 0 s · 1\.50 USD<\/h3>/,
  );
});

await test("CLV-341 a click on a tab asks for that tab, and the Agent turn tab shows the turn detail and hides the transcripts", () => {
  const chosen: RunTab[] = [];
  const shown = tabbed(controls("turn", chosen));
  assert.deepEqual(
    tabs(shown).map((tab) => [tab["children"], tab["aria-selected"]]),
    [
      ["Transcript", "false"],
      ["Agent turn", "true"],
    ],
  );
  assert.deepEqual(panels(shown), [
    ["run-panel-transcript", "run-tab-transcript", true],
    ["run-panel-turn", "run-tab-turn", false],
  ]);
  for (const tab of tabs(shown)) {
    assert.ok(typeof tab["onClick"] === "function");
    Reflect.apply(tab["onClick"], undefined, []);
  }
  assert.deepEqual(chosen, ["transcript", "turn"]);
});

await test("CLV-341 the code review of a round shows under its turn in both tabs", () => {
  const html = rendered(tabbed(controls("transcript", [])));
  for (const id of ["run-panel-transcript", "run-panel-turn"])
    assert.equal(
      [...part(html, id).matchAll(/<section class="review denied">/g)].length,
      1,
      id,
    );
});

await test("CLV-341 with no transcript controls, the Transcript tab is selected and a click changes nothing", () => {
  const shown = tabbed(undefined);
  assert.deepEqual(panels(shown), [
    ["run-panel-transcript", "run-tab-transcript", false],
    ["run-panel-turn", "run-tab-turn", true],
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
app.all("button").find((node) => node.text === "Agent turn").dispatch("click");
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
      tabs: [
        ["Transcript", "true"],
        ["Agent turn", "false"],
      ],
      hidden: [null, "true"],
    },
    clicked: {
      tabs: [
        ["Transcript", "false"],
        ["Agent turn", "true"],
      ],
      hidden: ["true", null],
    },
    refreshed: [
      ["Transcript", "false"],
      ["Agent turn", "true"],
    ],
    linked: [
      ["Transcript", "true"],
      ["Agent turn", "false"],
    ],
  });
});

await test("CLV-341 the tabs underline the selected tab, and a folded tool output shows its fold line as one row and opens under the gutter", () => {
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
    /display: flex/,
  );
  assert.match(
    rule(".transcript-lines details.tool-result > .output"),
    /margin: 2px 0 0 3ch/,
  );
});

await test("CLV-341 the README describes the two tabs of the run detail and the folded tool outputs", async () => {
  const readme = await readFile(
    new URL("../README.md", import.meta.url),
    "utf8",
  );
  assert.match(
    readme,
    /The run detail has one tab bar above the agent turns, with the tabs \*\*Transcript\*\* and \*\*Agent turn\*\*\. \*\*Transcript\*\* is selected by default\./,
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
