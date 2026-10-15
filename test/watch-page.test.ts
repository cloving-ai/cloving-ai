import { played } from "./watch-browser.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { component } from "../src/cli/watch-element.ts";
import { pageDocument } from "../src/cli/watch-page.ts";
import { pageTitle } from "../src/cli/watch-render.ts";
import { Page } from "../src/cli/watch-view.ts";
import { rendered } from "./watch-dom.ts";
import {
  noCopy,
  phases,
  sampleDecision,
  sampleModel,
  sampleRun,
} from "./watch-sample.ts";

const scenario = `
const model = JSON.parse(process.env.WATCH_MODEL);
const waiting = app.inner;
const [source] = sources;
source.onerror();
const stale = app.inner;
replies.push(model);
source.onmessage({ data: "change" });
await settled();
const first = { html: app.inner, title: document.title };
const fold = app.all("details").find((node) => !node.attributes.has("open"));
fold.setAttribute("open", "");
const [button] = app.all("button");
button.dispatch("click");
await settled();
const label = button.text;
globalThis.scrollY = 1200;
replies.push({ ...model, runs: model.runs.map((run) => ({ ...run, state: "running" })) });
await load();
replies.push(model, { ...model, service: "down" });
source.onmessage({ data: "change" });
source.onmessage({ data: "change" });
await settled();
await settled();
const kept = app.all("details").includes(fold) && fold.attributes.has("open");
const down = app.inner.includes("The Cloving service does not answer.");
location.hash = "#run-2";
listeners.hashchange();
console.log(JSON.stringify({ waiting, stale, first, label, kept, down, copied, scrolled, timers, other: document.title, streams: sources.map((item) => item.address), unread: replies.length }));
`;

await test("CLV-016 the watch page document has the components, a script that gets Preact from the watch server, listens to the event stream of the watch server and draws each second, and no outside resource", () => {
  const page = pageDocument();
  assert.match(page, /^<!doctype html>/);
  for (const part of [
    '<link rel="icon" href="data:,">',
    '<div id="app"></div>',
    '<script type="module">',
    'import { h as element, h as component, render } from "./preact.mjs";',
    "function Page(",
    "function pageTitle(",
    'fetch("data.json", { cache: "no-store" })',
    'new EventSource("events")',
    "setInterval(draw, 1000)",
    "setInterval(load, 15000)",
  ])
    assert.ok(page.includes(part), part);
  assert.equal(page.includes("setInterval(load, 1000)"), false);
  assert.equal(/https?:\/\//.test(page), false);
});

await test("CLV-077 saved links load an older run on arrival, refresh and hash navigation without replacing the run list", () => {
  const archived = sampleRun({
    runId: "run-1",
    state: "completed",
    latestAt: "2020-01-01T00:00:00Z",
    decisions: [],
  });
  const model = sampleModel([sampleRun({ runId: "recent" })]);
  const result = played(
    { ...model, archived },
    `
const { archived, ...model } = JSON.parse(process.env.WATCH_MODEL);
const [source] = sources;
replies.push(model, { run: archived });
source.onmessage({ data: "change" });
await settled();
const initial = { title: document.title, runs: state.model.runs.map((run) => run.runId) };
replies.length = 0;
replies.push(model, { run: archived });
await load();
const refreshed = document.title;
replies.length = 0;
replies.push(model);
location.hash = "#recent";
listeners.hashchange();
await settled();
const recent = document.title;
replies.length = 0;
replies.push(model, { run: archived });
location.hash = "#run-1";
listeners.hashchange();
await settled();
console.log(JSON.stringify({ initial, refreshed, recent, returned: document.title, requests }));
`,
  );
  const title = pageTitle(sampleModel([...model.runs, archived]), "run-1");
  assert.deepEqual(result, {
    initial: { title, runs: ["recent", "run-1"] },
    refreshed: title,
    recent: pageTitle(model, "recent"),
    returned: title,
    requests: [
      "data.json",
      "data.json?runId=run-1",
      "data.json",
      "data.json?runId=run-1",
      "data.json",
      "data.json",
      "data.json?runId=run-1",
    ],
  });
});

await test("CLV-079 a workflow and run hash reads the saved run and keeps its full page on reload", () => {
  const archived = sampleRun({
    runId: "old /&run",
    workflowId: "develop-issue",
  });
  const result = played(
    { ...sampleModel([]), archived },
    `
const { archived, ...model } = JSON.parse(process.env.WATCH_MODEL);
location.hash = "#workflow=develop-issue&run=old%20%2F%26run";
replies.push(model, { run: archived });
await load();
const first = app.inner;
replies.push(model, { run: archived });
await load();
console.log(JSON.stringify({ first, refreshed: app.inner, hash: location.hash, requests }));
`,
  );
  assert.deepEqual(result["requests"], [
    "data.json",
    "data.json?runId=old%20%2F%26run",
    "data.json",
    "data.json?runId=old%20%2F%26run",
  ]);
  assert.match(
    String(result["first"]),
    /href="#workflow=develop-issue">← Back to develop-issue/,
  );
  assert.match(String(result["first"]), /class="banner attention"/);
  assert.doesNotMatch(String(result["first"]), /class="workflows"|class="run /);
  assert.equal(result["first"], result["refreshed"]);
  assert.equal(result["hash"], "#workflow=develop-issue&run=old%20%2F%26run");
});

await test("CLV-077 an unavailable saved run never selects another run after navigation", () => {
  const result = played(
    sampleModel([sampleRun()]),
    `
const model = JSON.parse(process.env.WATCH_MODEL);
replies.push(model);
await load();
location.hash = "#missing";
replies.push(model, null);
listeners.hashchange();
await settled();
console.log(JSON.stringify({ title: document.title, selected: selectedRun(state.model, "missing")?.runId ?? null, stale: state.stale, html: app.inner }));
`,
  );
  assert.equal(result["title"], "Cloving");
  assert.equal(result["selected"], null);
  assert.equal(result["stale"], false);
  assert.match(String(result["html"]), /This run is not available/);
});

await test("CLV-016 the script of the watch page reads the data at each message of the event stream and draws it with Preact and its own copy of the components, keeps the nodes and a fold that the user opened, copies a command, follows the end of the page only while the run is in work and goes to the top when a decision arrives", () => {
  const done = sampleRun({
    runId: "run-2",
    state: "completed",
    decisions: [],
    turns: [],
    phases: phases(["done", "done", "done", "done", "done"]),
  });
  const model = sampleModel([done, sampleRun()]);
  const props = { now: model.updatedAt, copying: noCopy, selected: "run-1" };
  const page = (shown: Parameters<typeof Page>[0]): string =>
    rendered(component(Page, shown));
  assert.deepEqual(played(model, scenario), {
    waiting: page({ ...props, model: null, stale: false }),
    stale: page({ ...props, model: null, stale: true }),
    first: {
      html: page({ ...props, model, stale: false }),
      title: pageTitle(model, "run-1"),
    },
    label: "Copied",
    kept: true,
    down: true,
    copied: [sampleDecision.approve],
    scrolled: [0, 2000, 0],
    timers: [1000, 15000],
    other: pageTitle(model, "run-2"),
    streams: ["events"],
    unread: 0,
  });
});
