import { boardSizing } from "./watch-board-view.ts";

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

export const watchStyle = `
@font-face { font-family: "Fira Code"; font-style: normal; font-weight: 400; font-display: swap; src: url("/watch-fonts-v1/fira-code-latin-400-normal.woff2") format("woff2"); }
@font-face { font-family: "Fira Code"; font-style: normal; font-weight: 500; font-display: swap; src: url("/watch-fonts-v1/fira-code-latin-500-normal.woff2") format("woff2"); }
@font-face { font-family: "Heebo"; font-style: normal; font-weight: 500; font-display: swap; src: url("/watch-fonts-v1/heebo-latin-500-normal.woff2") format("woff2"); }
@font-face { font-family: "Heebo"; font-style: normal; font-weight: 700; font-display: swap; src: url("/watch-fonts-v1/heebo-latin-700-normal.woff2") format("woff2"); }
@font-face { font-family: "Heebo"; font-style: normal; font-weight: 800; font-display: swap; src: url("/watch-fonts-v1/heebo-latin-800-normal.woff2") format("woff2"); }
@font-face { font-family: "Space Grotesk"; font-style: normal; font-weight: 400; font-display: swap; src: url("/watch-fonts-v1/space-grotesk-latin-400-normal.woff2") format("woff2"); }
@font-face { font-family: "Space Grotesk"; font-style: normal; font-weight: 500; font-display: swap; src: url("/watch-fonts-v1/space-grotesk-latin-500-normal.woff2") format("woff2"); }
@font-face { font-family: "Space Grotesk"; font-style: normal; font-weight: 600; font-display: swap; src: url("/watch-fonts-v1/space-grotesk-latin-600-normal.woff2") format("woff2"); }
@font-face { font-family: "Space Grotesk"; font-style: normal; font-weight: 700; font-display: swap; src: url("/watch-fonts-v1/space-grotesk-latin-700-normal.woff2") format("woff2"); }
:root {${light}
  --heading-font: "Heebo", system-ui, sans-serif;
  --body-font: "Space Grotesk", system-ui, sans-serif;
  --code-font: "Fira Code", ui-monospace, SFMono-Regular, Menlo, monospace;
  --running: #1F9D55; --waiting: #D9A400; --needs-you: #0B5FB0; --stopped: #C21F32; --on-lamp: #FFFFFF; --on-waiting: #241B00;
  --line-1: #1F7A4D; --line-2: #0B5FB0; --line-3: #6A4BB0; --line-4: #B7791F;
  --station-width: 132px; --cut: 6px;
  --angled: polygon(var(--cut) 0, 100% 0, 100% calc(100% - var(--cut)), calc(100% - var(--cut)) 100%, 0 100%, 0 var(--cut));
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
body:has(.board-page) { padding-bottom: 0; overflow: hidden; }
.board-page { height: 100dvh; display: flex; flex-direction: column; overflow: hidden; }
.board-page > header, .board-page > .down { flex-shrink: 0; }
.workflow-refusals { flex-shrink: 0; max-height: 25dvh; overflow-y: auto; overflow-wrap: anywhere; }
.workflow-refusals h2 { margin: 8px 0; }
a { color: var(--accent-strong); }
.visually-hidden { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
.header-status { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.queue-lanes { padding: 2px 8px; border-radius: 999px; background: var(--surface-2); box-shadow: inset 0 0 0 1px var(--line); font-variant-numeric: tabular-nums; }
.header-actions { margin-left: auto; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
.queue-waiting { flex-shrink: 0; margin: 0 0 4px; color: var(--muted); font-size: 12px; }
.queue-waiting ul { margin: 6px 0 0; padding: 0 0 0 18px; columns: 220px; column-gap: 24px; max-height: 25dvh; overflow-y: auto; }
.phone { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin: 0; }
.phone-pairing { flex-basis: 100%; }
.phone-pairing div { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; }
.phone-qr { width: 196px; height: 196px; border-radius: 8px; }
.phone-ask { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.phone-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.phone-list li { display: flex; gap: 8px; align-items: center; color: var(--ink); }
header { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; padding: 18px 0 12px; color: var(--muted); font-size: 12px; }
.brand { display: inline-flex; align-items: center; gap: 9px; color: var(--ink); font: 800 26px/1.2 var(--heading-font); }
.brand svg { width: 30px; height: 30px; color: var(--accent); }
a:focus-visible, button:focus-visible, summary:focus-visible, input:focus-visible, textarea:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; box-shadow: 0 0 0 6px var(--code-bg); }
h2, h3 { font-family: var(--heading-font); font-weight: 700; }
.workspace { display: flex; width: 100%; margin-top: 12px; flex: 1; min-height: 0; }
.card small { color: var(--muted); font-size: 12px; }
.queue-message { color: var(--bad); font-size: 12px; }
.header-count { color: var(--muted); font-size: 14px; }
.header-count strong { margin-right: 3px; color: var(--ink); font: 700 20px/1 var(--heading-font); font-variant-numeric: tabular-nums; }
.header-count.needs-you strong { color: var(--needs-you); }
.floor-layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(260px, 340px); gap: 20px; align-items: start; margin-top: 12px; }
.floor-layout:has(> .side-panels:empty) { grid-template-columns: minmax(0, 1fr); }
.side-panels { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.side-panels:empty { display: none; }
.floor { min-width: 0; background: var(--surface); box-shadow: inset 0 0 0 1px var(--line); }
.today { background: var(--surface); box-shadow: inset 0 0 0 1px var(--line); }
.today-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; padding: 12px 20px 0; }
.today-head h2 { margin: 0; font-size: 18px; }
.today-since, .today-label, .today-yesterday { color: var(--muted); font-size: 13px; }
.today-numbers { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px 16px; padding: 12px 20px 16px; border-bottom: 1px solid var(--line); }
.today-number { display: flex; flex-direction: column; min-width: 0; }
.today-number strong { font: 700 28px/1.15 var(--heading-font); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.today-yesterday { font-size: 12px; }
.today-part { padding: 12px 20px 14px; border-bottom: 1px solid var(--line); }
.today-part h3 { margin: 0 0 8px; font-size: 15px; }
.today-chart { display: block; width: 100%; height: auto; }
.today-chart text { text-anchor: middle; font: 11px var(--body-font); fill: var(--muted); }
.today-bar rect { fill: color-mix(in srgb, var(--running) 40%, var(--surface)); }
.today-bar.current rect { fill: var(--line-1); }
.today-table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
.today-table th, .today-table td { padding: 6px 0 6px 8px; border-bottom: 1px solid var(--line); font-weight: 400; text-align: right; }
.today-table thead th { color: var(--muted); }
.today-table th:first-child { padding-left: 0; text-align: left; overflow-wrap: anywhere; }
.today-table tbody tr:last-child > * { border-bottom: 0; }
.today-queue { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; margin: 0; padding: 12px 20px; }
.lanes { display: inline-flex; gap: 3px; }
.lane { width: 14px; height: 12px; clip-path: var(--angled); }
.lane.busy { background: var(--running); }
.lane.free { background: var(--line); }
.floor-head { display: flex; align-items: center; justify-content: space-between; gap: 8px 16px; flex-wrap: wrap; padding: 12px 20px; border-bottom: 1px solid var(--line); }
.floor-head h2 { margin: 0; font-size: 18px; }
.legend { display: flex; flex-wrap: wrap; gap: 6px 16px; list-style: none; margin: 0; padding: 0; color: var(--muted); font-size: 13px; }
.legend li { display: inline-flex; align-items: center; gap: 8px; }
.lines { list-style: none; margin: 0; padding: 0; }
.line { display: grid; grid-template-columns: 180px minmax(0, 1fr) 170px; border-top: 1px solid var(--line); }
.line:first-child { border-top: 0; }
.line:nth-child(4n+1) { --line-color: var(--line-1); }
.line:nth-child(4n+2) { --line-color: var(--line-2); }
.line:nth-child(4n+3) { --line-color: var(--line-3); }
.line:nth-child(4n) { --line-color: var(--line-4); }
.line-name { position: relative; display: flex; flex-direction: column; gap: 2px; min-width: 0; padding: 16px 16px 16px 32px; overflow-wrap: anywhere; }
.line-name::before { content: ""; position: absolute; left: 18px; top: 16px; bottom: 16px; width: 5px; background: var(--line-color); clip-path: polygon(0 4px, 100% 0, 100% 100%, 0 100%); }
.line-name a { color: var(--ink); font: 700 17px/1.3 var(--heading-font); text-decoration: none; }
.line-name a:hover { text-decoration: underline; }
.line-active { color: var(--muted); font-size: 13px; }
.line-track { min-width: 0; overflow-x: auto; overscroll-behavior-x: contain; padding: 16px 20px; background: var(--surface-2); }
.stations { display: flex; justify-content: flex-start; width: max-content; list-style: none; margin: 0; padding: 0; }
.station { position: relative; flex: 0 0 var(--station-width); display: flex; flex-direction: column; align-items: flex-start; gap: 6px; padding-right: 12px; }
.station:not(:last-child)::after { content: ""; position: absolute; top: 10px; left: 11px; width: 100%; height: 2px; background: var(--muted); opacity: 0.45; }
.lamp { position: relative; z-index: 1; display: inline-block; flex-shrink: 0; width: 14px; height: 14px; margin: 4px; transform: rotate(45deg); background: var(--surface); box-shadow: inset 0 0 0 2px var(--muted); }
.lamp.running { background: var(--running); box-shadow: 0 0 0 4px color-mix(in srgb, var(--running) 22%, transparent); }
.lamp.waiting { background: var(--waiting); box-shadow: none; }
.lamp.needs-you { background: var(--needs-you); box-shadow: 0 0 0 4px color-mix(in srgb, var(--needs-you) 22%, transparent); }
.lamp.stopped { background: var(--stopped); box-shadow: none; }
.station-name { color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
.station:not(.empty) .station-name { color: var(--ink); font-weight: 600; }
.tokens { display: flex; flex-direction: column; gap: 6px; list-style: none; margin: 2px 0 0; padding: 0; }
.token { display: inline-flex; align-items: stretch; color: var(--ink); text-decoration: none; font: 500 13px/1.2 var(--body-font); font-variant-numeric: tabular-nums; white-space: nowrap; background: color-mix(in srgb, var(--lamp) 18%, var(--surface)); clip-path: var(--angled); }
.token.running { --lamp: var(--running); }
.token.waiting { --lamp: var(--waiting); }
.token.needs-you { --lamp: var(--needs-you); }
.token.stopped { --lamp: var(--stopped); }
.token:hover { background: color-mix(in srgb, var(--lamp) 30%, var(--surface)); }
.token-worker { display: grid; place-items: center; min-width: 26px; padding: 6px; background: var(--lamp); color: var(--on-lamp); font-weight: 700; }
.token.waiting .token-worker { color: var(--on-waiting); }
.token-ticket { padding: 6px 0 6px 10px; }
.token-time { padding: 6px 12px 6px 8px; color: var(--muted); }
.line-end { display: flex; flex-direction: column; align-items: flex-end; justify-content: center; gap: 2px; min-width: 0; padding: 16px 20px; border-left: 1px dashed var(--line); color: var(--muted); font-size: 13px; text-align: right; }
.line-ready { color: var(--ink); font-weight: 600; font-variant-numeric: tabular-nums; }
.line-wait { font-variant-numeric: tabular-nums; }
.board { width: 100%; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.columns { display: flex; align-items: flex-start; gap: ${String(boardSizing.gap)}px; flex: 1; min-height: 0; overflow-x: scroll; overflow-y: hidden; padding: 6px 6px 12px; scrollbar-color: var(--muted) var(--surface-2); }
@supports selector(::-webkit-scrollbar) { .columns { scrollbar-color: auto; } }
.columns::-webkit-scrollbar { height: 12px; }
.columns::-webkit-scrollbar-track { background: var(--surface-2); }
.columns::-webkit-scrollbar-thumb { background: var(--muted); border-radius: 6px; }
.column { flex: 1 0 ${String(boardSizing.minimumColumnWidth)}px; min-width: ${String(boardSizing.minimumColumnWidth)}px; max-height: 100%; display: flex; flex-direction: column; overflow: hidden; padding: 10px; border-radius: 14px; box-shadow: inset 0 0 0 1px var(--line); background: var(--surface-2); }
.column-name { display: flex; align-items: center; gap: 6px; flex-shrink: 0; margin: 0; padding: 4px 0 10px; color: var(--muted); font: 600 13px/1.5 var(--body-font); }
.column-count { font-variant-numeric: tabular-nums; }
.column-name > span:first-child { flex: 1; }
.column-cards { min-height: 0; overflow-y: auto; overscroll-behavior-y: contain; }
.column.collapsed { flex: 0 0 ${String(boardSizing.collapsedColumnWidth)}px; min-width: ${String(boardSizing.collapsedColumnWidth)}px; padding: 6px; }
.collapsed .column-name { writing-mode: vertical-rl; padding: 0; }
header button, .phone button, .column-name button, .add-card, .add-card-form button { font: 500 13px/1.4 var(--body-font); color: var(--ink); background: var(--surface-2); margin: 0; }
header button:hover, .phone button:hover, .column-name button:hover, .add-card:hover, .add-card-form button:hover { background: var(--line); }
.add-card, .add-card-form button { color: var(--ink); margin: 4px 8px 4px 0; }
.add-card { width: 100%; text-align: left; margin: 4px 0; }
.add-card-form { padding: 8px 0; overflow-wrap: anywhere; }
.add-card-form label { display: block; color: var(--ink); margin-bottom: 8px; }
.add-card-form input, .add-card-form textarea { display: block; width: 100%; min-width: 0; box-sizing: border-box; padding: 8px; border: 1px solid var(--line); border-radius: 6px; font: inherit; color: var(--ink); background: var(--surface); }
.add-card-form textarea { resize: vertical; }
.add-card-form button:disabled { opacity: 0.6; cursor: default; }
.add-card-form p { font-size: 12px; margin: 8px 0; }
.card { display: grid; gap: 6px; margin-bottom: 10px; padding: 12px; border-radius: 14px; box-shadow: inset 0 0 0 1px var(--line); color: var(--ink); overflow-wrap: anywhere; background: var(--surface); }
.card:hover { outline: 1px solid var(--accent-strong); }
.card-run { display: grid; gap: 4px; min-width: 0; color: inherit; text-decoration: none; }
.card-run strong { font-family: var(--heading-font); font-weight: 700; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
.completion-mark { font-size: 12px; }
.card-step, .card-review, .card-cost { font: 400 12px/1.6 var(--body-font); font-variant-numeric: tabular-nums; }
.card small { font: 400 11px/1.6 var(--code-font); }
.card-step, .card-review { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.card-step { color: var(--muted); }
.card-step.active { color: var(--accent-strong); }
.card-review { color: var(--muted); }
.review-pill { display: inline-block; padding: 1px 5px; border-radius: 5px; box-shadow: inset 0 0 0 1px var(--line); }
.decision-mark { width: fit-content; padding: 3px 7px; border-radius: 6px; background: linear-gradient(var(--warn-tint), var(--warn-tint)), var(--surface); color: var(--warn); font: 600 12px/1.6 var(--body-font); }
.column.stopped { background: var(--surface); box-shadow: inset 0 0 0 1px var(--bad), inset 0 0 0 100vmax var(--bad-tint); }
.column.stopped.collapsed { background: var(--surface-2); box-shadow: inset 0 0 0 1px var(--line); }
.stopped .column-name { color: var(--bad); background: var(--surface); border-radius: 6px; }
.stopped .card { background: linear-gradient(var(--bad-tint), var(--bad-tint)), var(--surface); box-shadow: inset 0 0 0 1px var(--bad); }
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
button { font: 500 12px/1.6 var(--code-font); border: 0; border-radius: 0; background: var(--code-line); color: var(--code-fg); clip-path: var(--angled); padding: 5px 12px; margin-right: 10px; cursor: pointer; }
button:hover { background: var(--code-head); }
button:focus-visible, .token:focus-visible { clip-path: none; }
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
.version { position: fixed; left: 12px; bottom: 8px; font: 12px/1.4 var(--code-font); color: var(--muted); pointer-events: none; }
@media (max-width: 1100px) {
  .floor-layout { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 720px) {
  .line { grid-template-columns: minmax(0, 1fr); }
  .line-name { padding-bottom: 8px; }
  .line-end { align-items: flex-start; border-left: 0; text-align: left; padding-top: 8px; }
  .line-end:empty { padding: 0; }
}
@media (max-width: 700px) { body { padding-inline: 12px; } }
`;
