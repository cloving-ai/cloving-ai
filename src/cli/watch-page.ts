import {
  Board,
  Card,
  WorkflowList,
  cardReview,
  cardStep,
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

const style = `
:root {
  color-scheme: light dark;
  font: 14px/1.5 system-ui, sans-serif;
  --line: light-dark(#d5d9df, #3a4049);
  --soft: light-dark(#5c6470, #a0a8b4);
  --good: light-dark(#17803d, #4cc27a);
  --bad: light-dark(#c02b2b, #ff7b72);
  --attention: light-dark(#a15c00, #f0b440);
  --working: light-dark(#1f5fd0, #6ea8ff);
}
body { margin: 0 auto; max-width: 1800px; padding: 0 16px 96px; }
header { display: flex; gap: 12px; align-items: baseline; padding: 10px 0 0; color: var(--soft); font-size: 12px; }
header strong { color: CanvasText; font-size: 14px; }
a:focus-visible, button:focus-visible { outline: 2px solid var(--working); outline-offset: 3px; }
.workspace { display: grid; grid-template-columns: 200px minmax(0, 1fr); gap: 24px; margin-top: 20px; }
.workflows { display: flex; flex-direction: column; gap: 8px; }
.workflows a { display: grid; gap: 2px; border-left: 3px solid transparent; padding: 10px; color: inherit; text-decoration: none; overflow-wrap: anywhere; }
.workflows a[aria-current="page"] { border-left-color: var(--working); background: light-dark(#edf3fc, #18273e); }
.workflows span, .card small { color: var(--soft); font-size: 12px; }
.board { min-width: 0; }
.board h2 { margin: 0 0 14px; font-size: 20px; }
.columns { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(210px, 1fr); gap: 12px; overflow-x: auto; padding-bottom: 14px; }
.column { min-width: 0; }
.column-name { margin: 0 0 10px; padding: 8px 0; border-top: 3px solid var(--line); color: var(--soft); }
.card { display: grid; gap: 6px; margin-bottom: 10px; padding: 12px; border: 1px solid var(--line); border-radius: 8px; color: inherit; text-decoration: none; overflow-wrap: anywhere; background: Canvas; }
.card:hover { border-color: var(--working); }
.card-step, .card-review, .card-cost { font-size: 12px; font-variant-numeric: tabular-nums; }
.decision-mark { color: var(--attention); font-size: 12px; font-weight: 600; }
.back { display: block; width: fit-content; margin: 16px 0; color: var(--working); }
@media (max-width: 700px) { .workspace { grid-template-columns: 150px minmax(0, 1fr); gap: 12px; } .workflows a { padding: 8px 4px; } }
.icon { font-weight: 700; color: var(--soft); }
.good .icon, .phase.done .mark, p.good { color: var(--good); }
.bad .icon, .phase.failed .mark, .bad, .down { color: var(--bad); }
.attention .icon { color: var(--attention); }
.working .icon, .phase.active .mark { color: var(--working); }
.banner { position: sticky; top: 0; z-index: 1; display: flex; gap: 12px; background: Canvas; border: 1px solid var(--line); border-left: 6px solid var(--soft); border-radius: 8px; padding: 10px 14px; }
.banner.good { border-left-color: var(--good); }
.banner.bad { border-left-color: var(--bad); }
.banner.attention { border-left-color: var(--attention); }
.banner.working { border-left-color: var(--working); }
.banner div { min-width: 0; flex: 1; }
.banner .icon { font-size: 22px; line-height: 1.2; }
.banner h2 { margin: 0; font-size: 18px; line-height: 1.45; }
.banner .name { font-weight: 400; font-size: 13px; color: var(--soft); margin-left: 6px; }
.banner p { margin: 2px 0 0; }
.now { display: block; color: var(--soft); font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.banner p, .phase .time, h3 { font-variant-numeric: tabular-nums; }
.phases { display: flex; gap: 4px; list-style: none; margin: 12px 0 4px; padding: 0; }
.phase { flex: 1; display: grid; grid-template-columns: auto 1fr; column-gap: 5px; border-top: 3px solid var(--line); padding-top: 6px; color: var(--soft); font-size: 12px; }
.phase.done, .phase.active, .phase.failed { color: CanvasText; }
.phase.done { border-top-color: var(--good); }
.phase.active { border-top-color: var(--working); font-weight: 600; }
.phase.failed { border-top-color: var(--bad); }
.phase .time { grid-column: 2; color: var(--soft); font-weight: 400; min-height: 18px; }
h3 { margin: 22px 0 6px; font-size: 14px; }
.meta { color: var(--soft); margin: 2px 0; font-size: 12px; }
.foot { margin-top: 18px; }
.decision { border: 1px solid var(--attention); border-radius: 8px; padding: 2px 14px 12px; margin-top: 14px; }
.decision h3 { margin-top: 10px; }
.review { border-left: 3px solid var(--bad); padding: 0 12px; margin-top: 10px; }
.review p { white-space: pre-wrap; }
.fact, p.good, p.bad { margin: 8px 0 4px; }
.report { white-space: pre-wrap; margin: 6px 0; max-height: 300px; overflow: auto; border-left: 3px solid var(--line); padding-left: 10px; }
pre, code, .activity, .events { font: 12px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; }
pre { white-space: pre-wrap; border: 1px solid var(--line); border-radius: 6px; padding: 8px 10px; margin: 4px 0; }
details { margin: 6px 0; }
summary { cursor: pointer; color: var(--soft); }
.command { display: flex; gap: 10px; align-items: center; border: 1px solid var(--line); border-radius: 6px; padding: 6px 10px; margin: 6px 0; }
.command .label { font-weight: 600; min-width: 62px; }
.command code { flex: 1; overflow-wrap: anywhere; }
button { font: inherit; border: 1px solid var(--line); border-radius: 6px; background: Canvas; color: CanvasText; padding: 2px 10px; cursor: pointer; }
.item { white-space: pre-wrap; overflow-wrap: anywhere; padding: 1px 0 1px 10px; border-left: 3px solid transparent; }
.item.say { border-left-color: var(--line); margin: 8px 0; font: 14px/1.5 system-ui, sans-serif; }
.item.tool { color: var(--soft); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.item.error { border-left-color: var(--bad); color: var(--bad); }
.item.result { border-left-color: var(--good); margin: 8px 0; font: 600 14px/1.5 system-ui, sans-serif; }
.tools summary { display: flex; gap: 10px; }
.tools summary::before { content: "▸"; }
.tools[open] summary::before { content: "▾"; }
.last { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; opacity: 0.75; }
.tools[open] .last { display: none; }
.event { color: var(--soft); }
.down { font-weight: 600; }
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
  const script = [
    'import { h as element, h as component, render } from "./preact.mjs";',
    ...functions.map((item) => item.toString()),
    loader,
  ].join("\n");
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Cloving</title><link rel="icon" href="data:,">',
    `<style>${style}</style></head><body>`,
    '<div id="app"></div>',
    `<script type="module">${script}</script></body></html>`,
    "",
  ].join("\n");
}
