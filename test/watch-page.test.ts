import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const browser = `
import { PageNode } from ${JSON.stringify(join(import.meta.dirname, "watch-dom.ts"))};
const app = new PageNode("div");
const listeners = {};
const timers = [];
const scrolled = [];
const copied = [];
const replies = [];
const requests = [];
const sources = [];
const settled = () => new Promise((settle) => { setImmediate(settle); });
const fixed = Date.parse(process.env.WATCH_NOW);
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...values) { super(...(values.length === 0 ? [fixed] : values)); }
};
Object.assign(globalThis, {
  document: { title: "", body: { scrollHeight: 2000 }, getElementById: () => app },
  location: { hash: "#run-1" },
  addEventListener: (type, listener) => { listeners[type] = listener; },
  setInterval: (callback, time) => { timers.push(time); return 0; },
  fetch: (address) => {
    requests.push(address);
    const available = replies.length > 0;
    const reply = replies.shift();
    return !available
      ? Promise.reject(new Error("no server"))
      : Promise.resolve({ ok: reply !== null, json: () => Promise.resolve(reply) });
  },
  innerHeight: 800,
  scrollY: 0,
  scrollTo: (left, top) => { scrolled.push(top); },
  EventSource: class {
    constructor(address) {
      this.address = address;
      sources.push(this);
    }
  },
});
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { clipboard: { writeText: (text) => { copied.push(text); return Promise.resolve(); } } },
});
`;

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

function fields(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? { ...value } : {};
}

function played(
  model: {
    readonly updatedAt: string;
    readonly archived?: ReturnType<typeof sampleRun>;
  },
  scriptScenario: string = scenario,
): Record<string, unknown> {
  const [, script = ""] =
    /<script type="module">([\s\S]*)<\/script>/.exec(pageDocument()) ?? [];
  const library = JSON.stringify(import.meta.resolve("preact"));
  const directory = mkdtempSync(join(tmpdir(), "cloving-watch-page-"));
  const file = join(directory, "page.mjs");
  writeFileSync(
    file,
    `${browser}${script.replace('"./preact.mjs"', library)}${scriptScenario}`,
  );
  const run = spawnSync(process.execPath, [file], {
    env: {
      ...process.env,
      WATCH_MODEL: JSON.stringify(model),
      WATCH_NOW: model.updatedAt,
    },
    encoding: "utf8",
  });
  rmSync(directory, { recursive: true });
  assert.equal(run.status, 0, run.stderr);
  const result: unknown = JSON.parse(run.stdout);
  return fields(result);
}

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
console.log(JSON.stringify({ title: document.title, selected: selectedRun(state.model, "missing")?.runId ?? null, stale: state.stale }));
`,
  );
  assert.deepEqual(result, { title: "Cloving", selected: null, stale: true });
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
  assert.deepEqual(played(model), {
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
