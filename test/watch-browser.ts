import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pageDocument } from "../src/cli/watch-page.ts";
import type { sampleRun } from "./watch-sample.ts";

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
  document: { title: "", querySelector: () => null, body: { scrollHeight: 2000 }, getElementById: () => app },
  location: { hash: "#run-1" },
  addEventListener: (type, listener) => { listeners[type] = listener; },
  setInterval: (callback, time) => { timers.push(time); return 0; },
  fetch: (address) => {
    requests.push(address);
    const available = replies.length > 0;
    const reply = replies.shift();
    if (reply instanceof Response) return Promise.resolve(reply);
    return !available
      ? Promise.reject(new Error("no server"))
      : Promise.resolve({ ok: reply !== null, status: reply === null ? 404 : 200, json: () => Promise.resolve(reply) });
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

function fields(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? { ...value } : {};
}

export function played(
  model: {
    readonly updatedAt: string;
    readonly cardForms?: unknown;
    readonly archived?: ReturnType<typeof sampleRun>;
  },
  scriptScenario: string,
): Record<string, unknown> {
  const [, script = ""] =
    /<script type="module">([\s\S]*)<\/script>/.exec(
      pageDocument(model.cardForms === undefined ? null : "a".repeat(64)),
    ) ?? [];
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
