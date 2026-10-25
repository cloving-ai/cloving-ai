import { activeBoardModel } from "./watch-board-fixture.ts";
import { played } from "./watch-browser.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { component } from "../src/cli/watch-element.ts";
import { pageDocument } from "../src/cli/watch-page.ts";
import { pageTitle } from "../src/cli/watch-render.ts";
import { clove, Page } from "../src/cli/watch-view.ts";
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

await test("CLV-016 the watch page document has the components, a script that gets Preact from the watch server, listens to the event stream of the watch server and draws each second, and only fixed optional font resources", () => {
  const page = pageDocument();
  assert.match(page, /^<!doctype html>/);
  for (const part of [
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
  const outside = [...page.matchAll(/https?:\/\/[^"<>\s]+/g)].map(
    (match) => match[0],
  );
  assert.deepEqual(
    [...new Set(outside.filter((url) => url !== "http://www.w3.org/2000/svg"))],
    [],
  );
  assert.doesNotMatch(page, /@import|<form/);
  assert.deepEqual(
    [...page.matchAll(/\bfetch\(([^,\n]+)/g)].map((call) => call[1]),
    [
      '"actions/run"',
      '"actions/phone/" + action',
      '"data.json?runId=" + encodeURIComponent(runId)',
      '"data.json"',
    ],
  );
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

for (const failure of ["server", "connection", "json", "mismatched run"]) {
  await test(`CLV-079 saved runs survive ${failure} errors and recover on refresh`, () => {
    const archived = sampleRun({
      runId: "run-1",
      workflowId: "develop-issue",
      detail: "Saved run details",
    });
    const result = played(
      { ...sampleModel([sampleRun({ runId: "recent" })]), archived },
      `
const { archived, ...model } = JSON.parse(process.env.WATCH_MODEL);
location.hash = "#workflow=develop-issue&run=run-1";
replies.push(model, { run: archived });
await load();
replies.push(model);
const failure = ${JSON.stringify(failure)};
if (failure === "server") replies.push(new Response(null, { status: 500 }));
if (failure === "json") replies.push(new Response("invalid json"));
if (failure === "mismatched run") replies.push({ run: { ...archived, runId: "other" } });
await load();
const failedHtml = app.inner;
const failedRuns = state.model.runs.map((run) => run.runId);
const stale = state.stale;
replies.push(model, { run: { ...archived, detail: "Refreshed saved run details" } });
await load();
console.log(JSON.stringify({ failedHtml, failedRuns, stale, recoveredHtml: app.inner, recoveredStale: state.stale, hash: location.hash }));
`,
    );
    assert.equal(result["stale"], true);
    assert.deepEqual(result["failedRuns"], ["recent", "run-1"]);
    assert.match(String(result["failedHtml"]), /Saved run/);
    assert.match(
      String(result["failedHtml"]),
      /The watch tool does not answer/,
    );
    assert.doesNotMatch(
      String(result["failedHtml"]),
      /This run is not available/,
    );
    assert.equal(result["recoveredStale"], false);
    assert.match(String(result["recoveredHtml"]), /Refreshed saved run/);
    assert.doesNotMatch(
      String(result["recoveredHtml"]),
      /The watch tool does not answer/,
    );
    assert.equal(result["hash"], "#workflow=develop-issue&run=run-1");
  });
}

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

await test("CLV-098 themes default to light, follow system dark only without a valid override, and load fixed fonts", () => {
  const page = pageDocument();
  assert.match(page, /:root\s*\{[^}]*color-scheme: light;/);
  assert.match(
    page,
    /@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\):not\(\[data-theme="dark"\]\)/,
  );
  for (const theme of ["light", "dark"]) {
    assert.ok(page.includes(`:root[data-theme="${theme}"]`));
  }
  assert.doesNotMatch(page, /<link rel="stylesheet"/);
  assert.equal([...page.matchAll(/<style>/g)].length, 1);
  assert.doesNotMatch(page, /light-dark\(|color-scheme: light dark/);
});

await test("CLV-130 nine packaged Latin font faces use fixed local URLs and swap while loading", () => {
  const page = pageDocument();
  const rules = [...page.matchAll(/@font-face\s*\{([^}]+)\}/g)];
  const expected = [
    ["Fira Code", "fira-code", [400, 500]],
    ["Heebo", "heebo", [500, 700, 800]],
    ["Space Grotesk", "space-grotesk", [400, 500, 600, 700]],
  ] as const;
  assert.equal(rules.length, 9);
  const declarations = rules.map((rule) =>
    rule[1]?.replace(/\s+/g, " ").trim(),
  );
  assert.deepEqual(
    declarations,
    expected.flatMap(([family, file, weights]) =>
      weights.map(
        (weight) =>
          `font-family: "${family}"; font-style: normal; font-weight: ${String(weight)}; font-display: swap; src: url("/watch-fonts-v1/${file}-latin-${String(weight)}-normal.woff2") format("woff2");`,
      ),
    ),
  );
  assert.doesNotMatch(
    page,
    /local\(|fonts\.googleapis|fonts\.gstatic|media="print"|onload=|blocking="render"/,
  );
});

await test("CLV-098 the embedded favicon uses the header clove shape with a fixed green fill", () => {
  const page = pageDocument();
  const icon = /<link rel="icon" href="data:image\/svg\+xml,([^"]+)">/.exec(
    page,
  )?.[1];
  assert.ok(icon);
  const svg = decodeURIComponent(icon);
  assert.match(svg, /xmlns="http:\/\/www.w3.org\/2000\/svg"/);
  assert.match(
    svg,
    /viewBox="0.6625858545303345 0.6630800366401672 46.674827575683594 46.673831939697266"/,
  );
  assert.equal([...svg.matchAll(/<path fill="#0BBF64"/g)].length, 4);
  assert.doesNotMatch(svg, /currentColor|<script/);
  assert.deepEqual(
    [...svg.matchAll(/ d="([^"]+)"/g)].map((path) => path[1]),
    clove.paths,
  );
});

await test("CLV-098 embedded board rendering includes review pills and stopped presentation", () => {
  const result = played(
    activeBoardModel(),
    `
location.hash = "#workflow=develop-issue";
replies.push(JSON.parse(process.env.WATCH_MODEL));
await load();
console.log(JSON.stringify({ html: app.inner, requests }));
`,
  );
  assert.match(String(result["html"]), /class="review-pill">round 2/);
  assert.match(String(result["html"]), /class="column stopped collapsed"/);
  assert.deepEqual(result["requests"], ["data.json"]);
});

await test("CLV-098 copy failure is shown for its command and long commands copy the complete original text", () => {
  const command = `cloving approve ${"long-run/".repeat(40)} --text "<yes> & done"`;
  const decision = { ...sampleDecision, approve: command };
  const model = sampleModel([sampleRun({ decisions: [decision] })]);
  const result = played(
    model,
    `
const model = JSON.parse(process.env.WATCH_MODEL);
replies.push(model);
await load();
navigator.clipboard.writeText = (text) => { copied.push(text); return Promise.reject(new Error("clipboard refused")); };
const [approve, deny] = app.all("button");
approve.dispatch("click");
await settled();
const failed = [approve.text, deny.text];
navigator.clipboard.writeText = (text) => { copied.push(text); return Promise.resolve(); };
approve.dispatch("click");
await settled();
console.log(JSON.stringify({ failed, recovered: approve.text, copied, requests, timers, code: app.all("code").map((node) => node.text) }));
`,
  );
  assert.deepEqual(result["failed"], ["Copy failed", "Copy"]);
  assert.equal(result["recovered"], "Copied");
  assert.deepEqual(result["copied"], [command, command]);
  assert.ok(Array.isArray(result["code"]) && result["code"].includes(command));
  assert.deepEqual(result["requests"], ["data.json"]);
  assert.deepEqual(result["timers"], [1000, 15000]);
});
