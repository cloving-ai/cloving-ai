import {
  escapeHtml,
  renderDecision,
  renderEvents,
  renderItem,
  renderPage,
  renderRun,
  renderRuns,
  renderTurn,
} from "./watch-render.ts";

const functions = [
  escapeHtml,
  renderItem,
  renderTurn,
  renderDecision,
  renderEvents,
  renderRun,
  renderRuns,
  renderPage,
];

const style = `
:root { color-scheme: light dark; font: 14px/1.45 system-ui, sans-serif; }
body { margin: 0 auto; max-width: 1000px; padding: 0 16px 80px; }
header { position: sticky; top: 0; background: Canvas; padding: 10px 0; border-bottom: 1px solid GrayText; }
header span { color: GrayText; margin-left: 12px; }
nav { display: flex; flex-wrap: wrap; gap: 6px; margin: 12px 0; }
a.run { border: 1px solid GrayText; border-radius: 6px; padding: 3px 9px; color: inherit; text-decoration: none; }
a.run.selected { background: Highlight; color: HighlightText; }
h2 { margin: 18px 0 4px; }
h3 { margin: 18px 0 6px; font-size: 14px; }
.meta { color: GrayText; margin: 2px 0; }
.state { padding: 1px 8px; border-radius: 10px; border: 1px solid GrayText; }
.events, .activity, pre { font: 12px/1.5 ui-monospace, monospace; }
.item { white-space: pre-wrap; padding: 2px 0 2px 10px; border-left: 3px solid transparent; }
.item.say { border-left-color: GrayText; margin: 6px 0; font: 13px/1.45 system-ui, sans-serif; }
.item.tool { color: GrayText; }
.item.error { border-left-color: #c33; color: #c33; }
.item.result { border-left-color: #2a7; font-weight: 600; margin-top: 8px; }
pre { white-space: pre-wrap; border: 1px solid GrayText; border-radius: 6px; padding: 10px; }
.decision { border-top: 2px solid Highlight; margin-top: 24px; }
.down { color: #c33; font-weight: 600; }
`;

const loader = `
let shown = "";
function clovingUpdate(model) {
  document.getElementById("stamp").textContent = "updated " + model.updatedAt.slice(11, 19) + " UTC";
  document.getElementById("host").textContent = model.host;
  const next = JSON.stringify([model.service, model.runs, location.hash]);
  if (next === shown) return;
  shown = next;
  const followed = innerHeight + scrollY >= document.body.scrollHeight - 80;
  document.getElementById("app").innerHTML = renderPage(model, location.hash.slice(1));
  if (followed) scrollTo(0, document.body.scrollHeight);
}
async function load() {
  try {
    const reply = await fetch("data.json", { cache: "no-store" });
    clovingUpdate(await reply.json());
  } catch {
    document.getElementById("stamp").textContent = "the watch tool does not answer";
  }
}
addEventListener("hashchange", () => { shown = ""; load(); });
load();
setInterval(load, 1000);
`;

export function pageDocument(): string {
  const script = `${functions.map((item) => item.toString()).join("\n")}\n${loader}`;
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8"><title>Cloving runs</title>',
    `<style>${style}</style></head><body>`,
    '<header><strong>Cloving</strong><span id="host"></span><span id="stamp"></span></header>',
    '<main id="app"><p class="meta">The page waits for the first data of the watch tool.</p></main>',
    `<script>${script}</script></body></html>`,
    "",
  ].join("\n");
}
