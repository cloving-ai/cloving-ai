import {
  counted,
  elapsed,
  escapeHtml,
  groupActivity,
  renderClock,
  renderCommand,
  renderDecision,
  renderEvents,
  renderGroup,
  renderItem,
  renderSince,
  renderTurn,
  renderWork,
  turnTime,
} from "./watch-render.ts";
import {
  bannerDetail,
  completedDetail,
  pageTitle,
  phaseTime,
  renderBanner,
  renderPage,
  renderPhases,
  renderRun,
  renderRuns,
  runName,
  runTone,
  selectedRun,
  toneOf,
  waitingDetail,
  workingDetail,
} from "./watch-view.ts";

const functions = [
  escapeHtml,
  counted,
  elapsed,
  renderSince,
  renderClock,
  renderItem,
  groupActivity,
  renderGroup,
  turnTime,
  renderTurn,
  renderWork,
  renderCommand,
  renderDecision,
  renderEvents,
  toneOf,
  runTone,
  runName,
  workingDetail,
  waitingDetail,
  completedDetail,
  bannerDetail,
  renderBanner,
  phaseTime,
  renderPhases,
  renderRun,
  renderRuns,
  selectedRun,
  pageTitle,
  renderPage,
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
body { margin: 0 auto; max-width: 980px; padding: 0 16px 96px; }
header { display: flex; gap: 12px; align-items: baseline; padding: 10px 0 0; color: var(--soft); font-size: 12px; }
header strong { color: CanvasText; font-size: 14px; }
nav { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0; }
a.run { border: 1px solid var(--line); border-radius: 999px; padding: 2px 10px; color: inherit; text-decoration: none; font-size: 12px; }
a.run.selected { border-color: CanvasText; font-weight: 600; }
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
[data-since] { font-variant-numeric: tabular-nums; }
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
let shown = "";
let state = "";
const folds = new Map();
function refold() {
  for (const fold of document.querySelectorAll("details[data-key]")) {
    const choice = folds.get(fold.dataset.key);
    if (choice !== undefined) fold.open = choice;
  }
}
function tick() {
  const now = new Date().toISOString();
  for (const item of document.querySelectorAll("[data-since]"))
    item.textContent = elapsed(item.dataset.since, now);
}
function localize() {
  for (const item of document.querySelectorAll("[data-clock]"))
    item.textContent = new Date(item.dataset.clock).toLocaleTimeString();
}
function stamped(text, tone) {
  const stamp = document.getElementById("stamp");
  stamp.textContent = text;
  stamp.className = tone;
}
function moved(next, followed) {
  const arrived = next === "waiting_gate" && next !== state;
  state = next;
  if (arrived) scrollTo(0, 0);
  else if (followed && next === "running") scrollTo(0, document.body.scrollHeight);
}
function clovingUpdate(model) {
  const selected = location.hash.slice(1);
  stamped("updated " + new Date(model.updatedAt).toLocaleTimeString(), "");
  document.getElementById("host").textContent = model.host;
  document.title = pageTitle(model, selected);
  const next = JSON.stringify([model.service, model.runs, selected]);
  if (next === shown) return;
  shown = next;
  const followed = innerHeight + scrollY >= document.body.scrollHeight - 80;
  document.getElementById("app").innerHTML = renderPage(model, selected);
  refold();
  localize();
  tick();
  moved(selectedRun(model, selected)?.state ?? "", followed);
}
async function load() {
  try {
    const reply = await fetch("data.json", { cache: "no-store" });
    clovingUpdate(await reply.json());
  } catch {
    stamped("The watch tool does not answer.", "bad");
  }
}
addEventListener("hashchange", () => { shown = ""; state = ""; load(); });
addEventListener("click", (event) => {
  const fold = event.target.closest("summary")?.parentElement;
  if (fold?.dataset.key !== undefined) folds.set(fold.dataset.key, !fold.open);
  const copy = event.target.closest("[data-copy]");
  if (copy === null) return;
  navigator.clipboard.writeText(copy.dataset.copy).then(
    () => { copy.textContent = "Copied"; },
    () => { copy.textContent = "Copy failed"; },
  );
});
load();
setInterval(load, 1000);
setInterval(tick, 1000);
`;

export function pageDocument(): string {
  const script = `${functions.map((item) => item.toString()).join("\n")}\n${loader}`;
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8"><title>Cloving</title><link rel="icon" href="data:,">',
    `<style>${style}</style></head><body>`,
    '<header><strong>Cloving</strong><span id="host"></span><span id="stamp"></span></header>',
    '<main id="app"><p class="meta">The page waits for the first data of the watch tool.</p></main>',
    `<script>${script}</script></body></html>`,
    "",
  ].join("\n");
}
