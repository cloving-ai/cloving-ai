import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pageDocument } from "../src/cli/watch-page.ts";
import { pageTitle, renderPage } from "../src/cli/watch-view.ts";
import { sampleModel, sampleRun } from "./watch-sample.ts";

const browser = `
const elements = new Map();
const element = (id) => {
  if (!elements.has(id)) elements.set(id, { textContent: "", innerHTML: "", className: "" });
  return elements.get(id);
};
const listeners = {};
const timers = [];
const scrolled = [];
const copied = [];
const fold = { dataset: { key: "k1:1" }, open: false };
const summary = { parentElement: fold, closest: (selector) => (selector === "summary" ? summary : null) };
const button = { dataset: { copy: "cloving approve x" }, textContent: "Copy", closest: (selector) => (selector === "[data-copy]" ? button : null) };
const since = { dataset: { since: "2026-10-13T21:26:02.000Z" }, textContent: "" };
const clock = { dataset: { clock: "2026-10-13T21:26:02.000Z" }, textContent: "" };
const found = { "details[data-key]": [fold], "[data-since]": [since], "[data-clock]": [clock] };
Object.assign(globalThis, {
  document: { title: "", body: { scrollHeight: 2000 }, getElementById: element, querySelectorAll: (selector) => found[selector] ?? [] },
  location: { hash: "#run-1" },
  addEventListener: (type, listener) => { listeners[type] = listener; },
  setInterval: (callback, time) => { timers.push(time); return 0; },
  fetch: () => Promise.reject(new Error("no server")),
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
clovingUpdate(model);
const first = {
  html: element("app").innerHTML,
  title: document.title,
  host: element("host").textContent,
  stamp: element("stamp").textContent,
  since: since.textContent,
  clock: clock.textContent,
  open: fold.open,
};
listeners.click({ target: summary });
element("app").innerHTML = "";
clovingUpdate(model);
const same = element("app").innerHTML;
globalThis.scrollY = 1200;
clovingUpdate({ ...model, service: "down" });
const second = { html: element("app").innerHTML, open: fold.open };
clovingUpdate({ ...model, runs: [{ ...model.runs[0], state: "running" }] });
clovingUpdate(model);
listeners.click({ target: button });
await new Promise((settle) => { setImmediate(settle); });
console.log(JSON.stringify({ first, same, second, copied, scrolled, timers, label: button.textContent, stale: element("stamp") }));
`;

function fields(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? { ...value } : {};
}

function played(model: unknown): Record<string, unknown> {
  const [, script] = /<script>([\s\S]*)<\/script>/.exec(pageDocument()) ?? [];
  const directory = mkdtempSync(join(tmpdir(), "cloving-watch-page-"));
  const file = join(directory, "page.mjs");
  writeFileSync(file, `${browser}${String(script)}${scenario}`);
  const run = spawnSync(process.execPath, [file], {
    env: { ...process.env, WATCH_MODEL: JSON.stringify(model) },
    encoding: "utf8",
  });
  rmSync(directory, { recursive: true });
  assert.equal(run.status, 0, run.stderr);
  const result: unknown = JSON.parse(run.stdout);
  return fields(result);
}

await test("CLV-016 the watch page document has the render functions and a loader that reads the data of the watch server each second, with no outside resource", () => {
  const page = pageDocument();
  assert.match(page, /^<!doctype html>/);
  for (const part of [
    '<link rel="icon" href="data:,">',
    "function renderPage(",
    "function escapeHtml(",
    "function clovingUpdate(",
    'fetch("data.json", { cache: "no-store" })',
    "setInterval(load, 1000)",
  ])
    assert.ok(page.includes(part), part);
  assert.equal(/https?:\/\//.test(page), false);
});

await test("CLV-016 the script of the watch page renders the data with its own copy of the render functions, sets the title, keeps a fold that the user changed, updates the live times, copies a command, follows the end of the page only while the run is in work and goes to the top when a decision arrives", () => {
  const model = sampleModel([sampleRun()]);
  const result = played(model);
  assert.partialDeepStrictEqual(result, {
    first: {
      html: renderPage(model, "run-1"),
      title: pageTitle(model, "run-1"),
      host: "/host",
      open: false,
    },
    same: "",
    second: { open: true },
    copied: ["cloving approve x"],
    scrolled: [0, 2000, 0],
    timers: [1000, 1000],
    label: "Copied",
    stale: { textContent: "The watch tool does not answer.", className: "bad" },
  });
  const first = fields(result["first"]);
  assert.match(String(first["stamp"]), /^updated \d/);
  assert.match(String(first["since"]), /^\d+ (s|min \d+ s|h \d+ min)$/);
  assert.match(String(first["clock"]), /\d/);
  assert.match(
    String(fields(result["second"])["html"]),
    /The Cloving service does not answer\./,
  );
});
