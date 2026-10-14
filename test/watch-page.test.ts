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
  fetch: () => replies.length === 0
    ? Promise.reject(new Error("no server"))
    : Promise.resolve({ json: () => Promise.resolve(replies.shift()) }),
  innerHeight: 800,
  scrollY: 0,
  scrollTo: (left, top) => { scrolled.push(top); },
});
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { clipboard: { writeText: (text) => { copied.push(text); return Promise.resolve(); } } },
});
`;

const scenario = `
const model = JSON.parse(process.env.WATCH_MODEL);
const waiting = app.inner;
await settled();
const stale = app.inner;
replies.push(model);
await load();
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
replies.push({ ...model, service: "down" });
await load();
const kept = app.all("details").includes(fold) && fold.attributes.has("open");
const down = app.inner.includes("The Cloving service does not answer.");
location.hash = "#run-2";
listeners.hashchange();
console.log(JSON.stringify({ waiting, stale, first, label, kept, down, copied, scrolled, timers, other: document.title }));
`;

function fields(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? { ...value } : {};
}

function played(model: {
  readonly updatedAt: string;
}): Record<string, unknown> {
  const [, script = ""] =
    /<script type="module">([\s\S]*)<\/script>/.exec(pageDocument()) ?? [];
  const library = JSON.stringify(import.meta.resolve("preact"));
  const directory = mkdtempSync(join(tmpdir(), "cloving-watch-page-"));
  const file = join(directory, "page.mjs");
  writeFileSync(
    file,
    `${browser}${script.replace('"./preact.mjs"', library)}${scenario}`,
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

await test("CLV-016 the watch page document has the components, a script that gets Preact from the watch server and reads the data each second, and no outside resource", () => {
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
    "setInterval(load, 1000)",
  ])
    assert.ok(page.includes(part), part);
  assert.equal(/https?:\/\//.test(page), false);
});

await test("CLV-016 the script of the watch page draws the data with Preact and its own copy of the components, keeps the nodes and a fold that the user opened, copies a command, follows the end of the page only while the run is in work and goes to the top when a decision arrives", () => {
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
    timers: [1000],
    other: pageTitle(model, "run-2"),
  });
});
