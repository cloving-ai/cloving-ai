import {
  Board,
  Card,
  CardReview,
  WorkflowList,
  cardReview,
  cardStep,
  completionMark,
} from "./watch-board-view.ts";
import {
  boardWorkflow,
  watchHash,
  watchLocation,
  watchTitle,
} from "./watch-navigation.ts";
import {
  clockTime,
  completedDetail,
  counted,
  elapsed,
  groupActivity,
  pageTitle,
  phaseTime,
  runName,
  runTone,
  selectedRun,
  toneOf,
  turnTime,
  waitingDetail,
} from "./watch-render.ts";
import {
  Command,
  Decision,
  Events,
  Group,
  Item,
  Turn,
  Work,
} from "./watch-turn.ts";
import {
  clove,
  Banner,
  BannerDetail,
  Header,
  Page,
  Phases,
  PullRequest,
  Review,
  Run,
} from "./watch-view.ts";

const functions = [
  watchHash,
  watchLocation,
  boardWorkflow,
  watchTitle,
  cardReview,
  cardStep,
  completionMark,
  CardReview,
  Card,
  WorkflowList,
  Board,
  counted,
  elapsed,
  clockTime,
  groupActivity,
  turnTime,
  toneOf,
  runTone,
  runName,
  waitingDetail,
  completedDetail,
  phaseTime,
  selectedRun,
  pageTitle,
  Item,
  Group,
  Turn,
  Work,
  Command,
  Decision,
  Events,
  BannerDetail,
  Banner,
  Phases,
  PullRequest,
  Review,
  Run,
  Header,
  Page,
];

const light = `
  color-scheme: light;
  --bg: #D6E7DF; --surface: #F4FAF6; --surface-2: #E4F0E9;
  --ink: #0E2310; --muted: #405C4C; --line: #B7D2C4;
  --accent: #0BBF64; --accent-strong: #026B3B;
  --accent-tint: rgba(11,191,100,0.14); --on-accent: #052213;
  --warn: #8A5A00; --warn-tint: rgba(214,150,20,0.16);
  --code-bg: #0F1D16; --code-head: #15271E; --code-fg: #D5E6DC;
  --code-line: #24392E; --code-muted: #86A394;
  --shadow: 0 18px 50px rgba(14,35,16,0.16);
  --bad: #C02B2B; --bad-tint: rgba(192,43,43,0.14);
`;
const dark = `
  color-scheme: dark;
  --bg: #141C18; --surface: #1B2520; --surface-2: #22302A;
  --ink: #E6F2EB; --muted: #A2BAAD; --line: #2E4037;
  --accent: #0BBF64; --accent-strong: #45DD92;
  --accent-tint: rgba(11,191,100,0.18); --on-accent: #052213;
  --warn: #F0C062; --warn-tint: rgba(240,192,98,0.14);
  --code-bg: #0A1410; --code-head: #112019; --code-fg: #D5E6DC;
  --code-line: #1F3329; --code-muted: #86A394;
  --shadow: 0 18px 50px rgba(0,0,0,0.45);
  --bad: #FF7B72; --bad-tint: rgba(255,123,114,0.14);
`;

const style = `
:root {${light}
  --heading-font: "Heebo", system-ui, sans-serif;
  --body-font: "Space Grotesk", system-ui, sans-serif;
  --code-font: "Fira Code", ui-monospace, SFMono-Regular, Menlo, monospace;
  font: 14px/1.5 var(--body-font);
  background: var(--bg); color: var(--ink);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]):not([data-theme="dark"]) {${dark}}
}
:root[data-theme="light"] {${light}}
:root[data-theme="dark"] {${dark}}
* { box-sizing: border-box; }
body { margin: 0 auto; max-width: 1800px; padding: 0 20px 96px; }
a { color: var(--accent-strong); }
header { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; padding: 22px 0 10px; color: var(--muted); font-size: 12px; }
.brand { display: inline-flex; align-items: center; gap: 9px; color: var(--ink); font: 800 26px/1.2 var(--heading-font); }
.brand svg { width: 30px; height: 30px; color: var(--accent); }
a:focus-visible, button:focus-visible, summary:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; box-shadow: 0 0 0 6px var(--code-bg); }
h2, h3 { font-family: var(--heading-font); font-weight: 700; }
.workspace { display: grid; grid-template-columns: 200px minmax(0, 1fr); gap: 24px; margin-top: 20px; }
.workflows { display: flex; flex-direction: column; gap: 8px; }
.workflows a { display: grid; gap: 2px; border-bottom: 3px solid transparent; padding: 10px; color: inherit; text-decoration: none; overflow-wrap: anywhere; }
.workflows a[aria-current="page"] { border-bottom-color: var(--accent); background: var(--surface); border-radius: 8px 8px 0 0; }
.workflows span, .card small { color: var(--muted); font-size: 12px; }
.board { min-width: 0; }
.board h2 { margin: 0 0 14px; font-size: 24px; }
.columns { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(230px, 1fr); gap: 12px; overflow-x: auto; padding: 6px 6px 24px; }
.column { min-width: 0; padding: 10px; border-radius: 14px; box-shadow: inset 0 0 0 1px var(--line); background: var(--surface-2); }
.column-name { margin: 0 0 10px; padding: 8px 4px; color: var(--muted); font: 500 12px/1.5 var(--code-font); }
.card { display: grid; gap: 6px; margin-bottom: 10px; padding: 12px; border-radius: 14px; box-shadow: inset 0 0 0 1px var(--line), var(--shadow); color: var(--ink); overflow-wrap: anywhere; background: var(--surface); }
.card:hover { outline: 1px solid var(--accent-strong); }
.card-run { display: grid; gap: 8px; color: inherit; text-decoration: none; }
.card-run strong { font-family: var(--heading-font); font-weight: 700; }
.completion-mark { font-size: 12px; }
.card-step, .card-review, .card-cost, .card small { font: 400 12px/1.6 var(--code-font); font-variant-numeric: tabular-nums; }
.card-step { color: var(--muted); }
.card-step.active { color: var(--accent-strong); }
.card-review { color: var(--muted); }
.review-pill { display: inline-block; padding: 1px 5px; border-radius: 5px; box-shadow: inset 0 0 0 1px var(--line); }
.decision-mark { width: fit-content; padding: 3px 7px; border-radius: 6px; background: linear-gradient(var(--warn-tint), var(--warn-tint)), var(--surface); color: var(--warn); font: 500 12px/1.6 var(--code-font); }
.column.stopped { background: var(--surface); box-shadow: inset 0 0 0 1px var(--bad), inset 0 0 0 100vmax var(--bad-tint); }
.stopped .column-name { color: var(--bad); background: var(--surface); border-radius: 6px; }
.stopped .card { background: linear-gradient(var(--bad-tint), var(--bad-tint)), var(--surface); box-shadow: inset 0 0 0 1px var(--bad), var(--shadow); }
.back { display: block; width: fit-content; margin: 16px 0; }
.icon { font-weight: 700; color: var(--muted); }
.good .icon, .phase.done .mark, p.good { color: var(--accent-strong); }
.bad .icon, .phase.failed .mark, .bad, .down { color: var(--bad); }
.attention .icon { color: var(--warn); }
.working .icon, .phase.active .mark, .banner.working h2 { color: var(--accent-strong); }
.banner { position: sticky; top: 0; z-index: 1; display: flex; gap: 12px; background: var(--surface); box-shadow: var(--shadow); border: 1px solid var(--line); border-left: 6px solid var(--muted); border-radius: 14px; padding: 14px; }
.banner.good, .banner.working { border-left-color: var(--accent-strong); }
.banner.bad { border-left-color: var(--bad); }
.banner.attention { border-left-color: var(--warn); }
.banner div { min-width: 0; flex: 1; }
.banner .icon { font-size: 22px; line-height: 1.2; }
.banner h2 { margin: 0; font-size: 20px; line-height: 1.45; }
.banner .name { font: 400 13px/1.5 var(--body-font); color: var(--muted); margin-left: 6px; }
.banner p { margin: 2px 0 0; }
.now { display: block; color: var(--muted); font: 12px/1.6 var(--code-font); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.banner p, .phase .time, h3 { font-variant-numeric: tabular-nums; }
.phases { display: flex; gap: 8px; list-style: none; margin: 18px 0 4px; padding: 12px; border-radius: 14px; background: var(--surface); box-shadow: inset 0 0 0 1px var(--line); overflow-x: auto; }
.phase { flex: 1; min-width: 110px; display: grid; grid-template-columns: auto 1fr; column-gap: 7px; border-top: 2px solid var(--line); padding-top: 10px; color: var(--muted); font: 400 12px/1.6 var(--code-font); }
.phase .mark { display: grid; place-items: center; width: 24px; height: 24px; border-radius: 50%; box-shadow: inset 0 0 0 1px var(--line); }
.phase.done, .phase.active, .phase.failed { color: var(--ink); }
.phase.done, .phase.active { border-top-color: var(--accent-strong); }
.phase.active { font-weight: 500; }
.phase.active .mark { background: var(--accent-tint); }
.phase.failed { border-top-color: var(--bad); }
.phase .time { grid-column: 2; color: var(--muted); font-weight: 400; min-height: 18px; }
h3 { margin: 22px 0 6px; font-size: 16px; }
.meta { color: var(--muted); margin: 2px 0; font-size: 12px; overflow-wrap: anywhere; }
.foot { margin-top: 18px; }
.decision { background: var(--surface); box-shadow: var(--shadow); border: 1px solid var(--warn); border-radius: 14px; padding: 2px 14px 12px; margin-top: 18px; }
.decision h3 { margin-top: 10px; }
.review { border-left: 3px solid var(--bad); padding: 0 12px; margin-top: 10px; }
.review p { white-space: pre-wrap; }
.fact, p.good, p.bad { margin: 8px 0 4px; }
.report { white-space: pre-wrap; margin: 6px 0; max-height: 300px; overflow: auto; border-left: 3px solid var(--line); padding-left: 10px; }
pre, code, .activity, .events { font: 400 12px/1.6 var(--code-font); }
pre { background: var(--code-bg); color: var(--code-fg); white-space: pre-wrap; overflow-wrap: anywhere; border: 1px solid var(--code-line); border-radius: 8px; padding: 10px; margin: 4px 0; }
details { margin: 6px 0; }
summary { cursor: pointer; color: var(--muted); }
.code-window { background: var(--code-bg); color: var(--code-fg); border-radius: 14px; box-shadow: inset 0 0 0 1px var(--code-line), var(--shadow); overflow-wrap: anywhere; }
.code-head { background: var(--code-head); color: var(--code-fg); padding: 10px 12px; border-bottom: 1px solid var(--code-line); border-radius: 14px 14px 0 0; font: 500 12px/1.6 var(--code-font); }
.turn { margin-top: 22px; }
.turn h3 { margin: 0; }
.turn .meta { padding: 8px 12px; color: var(--code-muted); }
.activity { padding: 4px 12px 12px; }
.code-window summary, .code-window .event, .code-window .item.tool { color: var(--code-muted); }
.code-window .bad, .code-window .item.error { color: #FF7B72; }
.code-window .item.error { border-left-color: #FF7B72; }
.code-window .item.result { color: var(--accent); border-left-color: var(--accent); }
.command { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: center; margin: 10px 0; padding-bottom: 10px; }
.command .label { grid-column: 1 / -1; }
.command code { min-width: 0; padding-left: 12px; overflow-wrap: anywhere; white-space: pre-wrap; }
button { font: 500 12px/1.6 var(--code-font); border: 0; border-radius: 6px; background: transparent; color: var(--code-fg); box-shadow: inset 0 0 0 2px var(--code-line); padding: 5px 10px; margin-right: 10px; cursor: pointer; }
button:hover { background: var(--code-head); }
.item { white-space: pre-wrap; overflow-wrap: anywhere; padding: 1px 0 1px 10px; border-left: 3px solid transparent; }
.item.say { border-left-color: var(--code-line); margin: 8px 0; font: 14px/1.5 var(--body-font); }
.item.tool { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.item.result { margin: 8px 0; font: 500 14px/1.5 var(--body-font); }
.tools summary { display: flex; gap: 10px; }
.tools summary::before { content: "▸"; }
.tools[open] summary::before { content: "▾"; }
.last { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tools[open] .last { display: none; }
.event { padding: 1px 12px; }
.events { margin-top: 18px; padding-bottom: 10px; }
.events > summary { color: var(--code-fg); }
.down { font-weight: 600; }
@media (max-width: 700px) { body { padding-inline: 12px; } .workspace { grid-template-columns: minmax(0, 1fr); gap: 12px; } .workflows { flex-direction: row; overflow-x: auto; padding: 6px; } .workflows a { flex-shrink: 0; } }
`;

const loader = `
const state = { model: null, stale: false, copied: "", label: "", run: "", loading: false, again: false };
function moved(next, followed) {
  const arrived = next === "waiting_gate" && next !== state.run;
  state.run = next;
  if (arrived) scrollTo(0, 0);
  else if (followed && next === "running") scrollTo(0, document.body.scrollHeight);
}
function copy(command) {
  const shown = (label) => {
    state.copied = command;
    state.label = label;
    draw();
  };
  navigator.clipboard.writeText(command).then(
    () => { shown("Copied"); },
    () => { shown("Copy failed"); },
  );
}
function draw() {
  const { model, stale } = state;
  const selected = location.hash.slice(1);
  const followed = innerHeight + scrollY >= document.body.scrollHeight - 80;
  const copying = { command: state.copied, label: state.label, onCopy: copy };
  const now = new Date().toISOString();
  const page = component(Page, { model, selected, now, stale, copying });
  render(page, document.getElementById("app"));
  if (model === null) return;
  document.title = watchTitle(model, selected);
  const { runId } = watchLocation(selected);
  moved(model.runs.find((run) => run.runId === runId)?.state ?? "", followed);
}
async function withSelectedRun(model) {
  const { runId } = watchLocation(location.hash);
  if (runId === null || model.runs.some((run) => run.runId === runId)) return model;
  const detail = await fetch("data.json?runId=" + encodeURIComponent(runId), { cache: "no-store" });
  if (detail.status === 404) return model;
  if (!detail.ok) throw new Error("watch-run-not-available");
  const { run } = await detail.json();
  if (run?.runId !== runId) throw new Error("watch-run-mismatch");
  return { ...model, runs: [...model.runs, run] };
}
async function load() {
  state.again = state.loading;
  if (state.loading) return;
  state.loading = true;
  try {
    const reply = await fetch("data.json", { cache: "no-store" });
    if (!reply.ok) throw new Error("watch-not-available");
    state.model = await withSelectedRun(await reply.json());
    state.stale = false;
  } catch {
    state.stale = true;
  }
  state.loading = false;
  draw();
  if (state.again) load();
}
function listen() {
  const source = new EventSource("events");
  source.onmessage = () => { load(); };
  source.onerror = () => { state.stale = true; draw(); };
}
addEventListener("hashchange", () => { state.run = ""; draw(); load(); });
draw();
listen();
setInterval(draw, 1000);
setInterval(load, 15000);
`;

export function pageDocument(): string {
  const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${clove.viewBox}">${clove.paths.map((d) => `<path fill="#0BBF64" d="${d}"/>`).join("")}</svg>`;
  const script = [
    'import { h as element, h as component, render } from "./preact.mjs";',
    `const clove = ${JSON.stringify(clove)};`,
    ...functions.map((item) => item.toString()),
    loader,
  ].join("\n");
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Cloving</title>',
    `<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(icon)}">`,
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;500&amp;family=Heebo:wght@500;700;800&amp;family=Space+Grotesk:wght@400..700&amp;display=swap" media="print" onload="this.media=\'all\'">',
    `<style>${style}</style></head><body>`,
    '<div id="app"></div>',
    `<script type="module">${script}</script></body></html>`,
    "",
  ].join("\n");
}
