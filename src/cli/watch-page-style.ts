import { boardSizing } from "./watch-board-view.ts";
import { fontFaces } from "./watch-fonts.ts";

const dark = `
  color-scheme: dark;
  --color-page: #141C18; --color-surface: #1B2520; --color-panel: #22302A;
  --color-ink: #E6F2EB; --color-muted: #A2BAAD; --color-line: #2E4037;
  --color-accent: #0BBF64; --color-accent-strong: #45DD92; --color-on-accent: #052213;
  --color-warn: #F0C062; --color-bad: #FF7B72;
  --color-code-background: #0A1410; --color-code-header: #112019; --color-code-text: #D5E6DC;
  --color-code-line: #1F3329; --color-code-muted: #86A394;
`;

export const watchStyle = `
${fontFaces}
:root {
  color-scheme: light;
  --color-page: #D6E7DF; --color-surface: #F4FAF6; --color-panel: #E4F0E9;
  --color-ink: #0E2310; --color-muted: #405C4C; --color-line: #B7D2C4;
  --color-accent: #0BBF64; --color-accent-strong: #026B3B; --color-on-accent: #052213;
  --color-warn: #8A5A00; --color-bad: #C02B2B;
  --color-code-background: #0F1D16; --color-code-header: #15271E; --color-code-text: #D5E6DC;
  --color-code-line: #24392E; --color-code-muted: #86A394;
  --color-state-running: #1F9D55; --color-state-waiting: #D9A400; --color-state-attention: #0B5FB0;
  --color-state-completed: #1F7A4D; --color-state-failed: #C21F32;
  --shape-cut: 6px; --shape-radius: 14px; --shape-border: 1px;
  --size-text: 14px; --size-gap: 20px;
  --font-ui: "Space Grotesk", system-ui, sans-serif;
  --font-heading: "Heebo", system-ui, sans-serif;
  --font-code: "Fira Code", ui-monospace, SFMono-Regular, Menlo, monospace;
  --accent-tint: color-mix(in srgb, var(--color-accent) 16%, transparent);
  --warn-tint: color-mix(in srgb, var(--color-warn) 12%, transparent);
  --bad-tint: color-mix(in srgb, var(--color-bad) 14%, transparent);
  --shadow: 0 18px 50px color-mix(in srgb, var(--color-code-background) 24%, transparent);
  --on-lamp: #FFFFFF; --on-waiting: #241B00;
  --line-1: #1F7A4D; --line-2: #0B5FB0; --line-3: #6A4BB0; --line-4: #B7791F;
  --station-width: 132px;
  --angled: polygon(var(--shape-cut) 0, 100% 0, 100% calc(100% - var(--shape-cut)), calc(100% - var(--shape-cut)) 100%, 0 100%, 0 var(--shape-cut));
  font: var(--size-text)/1.5 var(--font-ui);
  background: var(--color-page); color: var(--color-ink);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-scheme="light"]) {${dark}}
}
:root[data-scheme="dark"] {${dark}}
* { box-sizing: border-box; }
body { margin: 0 auto; max-width: 1800px; padding: 0 20px 96px; }
body:has(.board-page) { padding-bottom: 0; overflow: hidden; }
.board-page { height: 100dvh; display: flex; flex-direction: column; overflow: hidden; }
.board-page > header, .board-page > .down { flex-shrink: 0; }
.workflow-refusals { flex-shrink: 0; max-height: 25dvh; overflow-y: auto; overflow-wrap: anywhere; }
.workflow-refusals h2 { margin: 8px 0; }
a { color: var(--color-accent-strong); }
.visually-hidden { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
.header-status { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.queue-lanes { padding: 2px 8px; border-radius: 999px; background: var(--color-panel); box-shadow: inset 0 0 0 var(--shape-border) var(--color-line); font-variant-numeric: tabular-nums; }
.restart-pending { padding: 2px 8px; border-radius: 999px; background: var(--warn-tint); box-shadow: inset 0 0 0 var(--shape-border) var(--color-warn); }
.header-actions { margin-left: auto; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
.queue-waiting { flex-shrink: 0; margin: 0 0 4px; color: var(--color-muted); font-size: 12px; }
.queue-waiting ul { margin: 6px 0 0; padding: 0 0 0 18px; columns: 220px; column-gap: 24px; max-height: 25dvh; overflow-y: auto; }
.phone { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin: 0; }
.phone-pairing { flex-basis: 100%; }
.phone-pairing div { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; }
.phone-qr { width: 196px; height: 196px; border-radius: calc(var(--shape-radius) / 2); }
.phone-ask { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.phone-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.phone-list li { display: flex; gap: 8px; align-items: center; color: var(--color-ink); }
header { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; padding: 18px 0 12px; color: var(--color-muted); font-size: 12px; }
.brand { display: inline-flex; align-items: center; gap: 9px; color: var(--color-ink); font: 800 26px/1.2 "Heebo", system-ui, sans-serif; }
.brand svg { width: 30px; height: 30px; color: #0BBF64; }
a:focus-visible, button:focus-visible, summary:focus-visible, input:focus-visible, textarea:focus-visible { outline: 3px solid var(--color-accent); outline-offset: 2px; box-shadow: 0 0 0 6px var(--color-code-background); }
h2, h3 { font-family: var(--font-heading); font-weight: 700; }
.workspace { display: flex; width: 100%; margin-top: 12px; flex: 1; min-height: 0; }
.card small { color: var(--color-muted); font-size: 12px; }
.queue-message { color: var(--color-bad); font-size: 12px; }
.header-count { color: var(--color-muted); font-size: 14px; }
.header-count strong { margin-right: 3px; color: var(--color-ink); font: 700 20px/1 var(--font-heading); font-variant-numeric: tabular-nums; }
.header-count.needs-you strong { color: var(--color-state-attention); }
.floor-layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(260px, 340px); gap: var(--size-gap); align-items: start; margin-top: 12px; }
.floor-layout:has(> .side-panels:empty) { grid-template-columns: minmax(0, 1fr); }
.side-panels { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.side-panels:empty { display: none; }
.floor { min-width: 0; background: var(--color-surface); box-shadow: inset 0 0 0 var(--shape-border) var(--color-line); }
.today { background: var(--color-surface); box-shadow: inset 0 0 0 var(--shape-border) var(--color-line); }
.today-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; padding: 12px 20px 0; }
.today-head h2 { margin: 0; font-size: 18px; }
.today-since, .today-label, .today-yesterday { color: var(--color-muted); font-size: 13px; }
.today-numbers { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px 16px; padding: 12px 20px 16px; border-bottom: var(--shape-border) solid var(--color-line); }
.today-number { display: flex; flex-direction: column; min-width: 0; }
.today-number strong { font: 700 28px/1.15 var(--font-heading); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.today-yesterday { font-size: 12px; }
.today-unknown { color: var(--color-muted); font-size: 12px; }
.today-part { padding: 12px 20px 14px; border-bottom: var(--shape-border) solid var(--color-line); }
.today-part h3 { margin: 0 0 8px; font-size: 15px; }
.today-chart { display: block; width: 100%; height: auto; }
.today-chart text { text-anchor: middle; font: 11px var(--font-ui); fill: var(--color-muted); }
.today-bar rect { fill: color-mix(in srgb, var(--color-state-completed) 40%, var(--color-surface)); }
.today-bar.current rect { fill: var(--color-state-completed); }
.today-table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
.today-table th, .today-table td { padding: 6px 0 6px 8px; border-bottom: var(--shape-border) solid var(--color-line); font-weight: 400; text-align: right; }
.today-table thead th { color: var(--color-muted); }
.today-table th:first-child { padding-left: 0; text-align: left; overflow-wrap: anywhere; }
.today-table tbody tr:last-child > * { border-bottom: 0; }
.today-queue { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; margin: 0; padding: 12px 20px; }
.loops { background: var(--color-surface); box-shadow: inset 0 0 0 var(--shape-border) var(--color-line); }
.loops h2 { margin: 0; padding: 12px 20px; font-size: 18px; border-bottom: var(--shape-border) solid var(--color-line); }
.loops-list { list-style: none; margin: 0; padding: 0; }
.loop { display: flex; flex-direction: column; gap: 4px; padding: 12px 20px; border-bottom: var(--shape-border) solid var(--color-line); }
.loop:last-child { border-bottom: 0; }
.loop-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.loop-workflow { font-weight: 700; overflow-wrap: anywhere; }
.loop-state { font-size: 13px; font-weight: 700; }
.loop-active .loop-state { color: var(--color-state-running); }
.loop-paused .loop-state { color: var(--color-state-waiting); }
.loop-stopped .loop-state { color: var(--color-state-failed); }
.loop p { margin: 0; color: var(--color-muted); font-size: 13px; overflow-wrap: anywhere; }
.loop-actions { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 4px; }
.loop-switch { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; }
.loop-run { border: 0; cursor: pointer; padding: 6px 12px; background: var(--color-panel); color: var(--color-ink); font: inherit; font-size: 13px; clip-path: var(--angled); }
.loop-run:disabled { cursor: progress; opacity: 0.6; }
.loop-run:focus-visible { clip-path: none; }
.loop p.loop-message { color: var(--color-ink); font-size: 13px; }
.lanes { display: inline-flex; gap: 3px; }
.lane { width: 14px; height: 12px; clip-path: var(--angled); }
.lane.busy { background: var(--color-state-running); }
.lane.free { background: var(--color-line); }
.floor-head { display: flex; align-items: center; justify-content: space-between; gap: 8px 16px; flex-wrap: wrap; padding: 12px 20px; border-bottom: var(--shape-border) solid var(--color-line); }
.floor-head h2 { margin: 0; font-size: 18px; }
.floor-main { display: flex; flex-direction: column; gap: var(--size-gap); min-width: 0; }
.needs { background: var(--color-surface); box-shadow: inset 0 0 0 var(--shape-border) var(--color-line); }
.needs-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px 16px; flex-wrap: wrap; padding: 12px 20px; border-bottom: var(--shape-border) solid var(--color-line); }
.needs-head h2 { margin: 0; font-size: 18px; }
.needs-count { color: var(--color-muted); font-size: 13px; font-variant-numeric: tabular-nums; }
.needs-list { list-style: none; margin: 0; padding: 0; }
.needs-empty { margin: 0; padding: 16px 20px; color: var(--color-muted); }
.need { display: flex; align-items: center; gap: 12px 16px; padding: 14px 20px; border-top: var(--shape-border) solid var(--color-line); }
.need:first-child { border-top: 0; }
.need-decision { --mark: var(--color-state-attention); }
.need-stopped { --mark: var(--color-state-failed); }
.need-mark { align-self: stretch; flex: 0 0 5px; background: var(--mark); }
.need-body { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.need-title { margin: 0; font-size: 16px; line-height: 1.3; }
.need-text { margin: 4px 0 2px; }
.need-meta { margin: 0; color: var(--color-muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.need-message { margin: 4px 0 0; font-size: 13px; }
.need-note { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 8px; }
.need-note label { display: grid; gap: 4px; min-width: 240px; font-size: 12px; color: var(--color-muted); }
.need-note input { padding: 6px 8px; border: var(--shape-border) solid var(--color-line); border-radius: calc(var(--shape-radius) / 2); background: var(--color-surface); color: var(--color-ink); font: inherit; }
.run-notes h3 { margin: 12px 0 4px; font-size: 14px; }
.note-mark { width: fit-content; font: 600 12px/1.6 var(--font-ui); color: var(--color-warn); }
.steer { display: grid; gap: 4px; margin: 6px 0; }
.steer-open { width: fit-content; }
.steer-form { display: grid; gap: 6px; }
.steer-form label { display: grid; gap: 4px; font-size: 12px; color: var(--color-muted); }
.steer-form label:has(input) { display: flex; align-items: center; gap: 6px; }
.steer-form textarea { padding: 6px 8px; border: var(--shape-border) solid var(--color-line); border-radius: calc(var(--shape-radius) / 2); background: var(--color-surface); color: var(--color-ink); font: inherit; }
.steer-message { margin: 0; font-size: 12px; }
.run-command { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 6px 0; }
.run-command-message { flex-basis: 100%; margin: 0; font-size: 12px; }
.board > .run-command-message, .floor > .run-command-message { flex: none; padding: 6px 20px 0; }
.drop-question { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 0; font-size: 13px; }
.run-menu summary { width: fit-content; padding: 0 8px; cursor: pointer; list-style: none; color: var(--color-muted); font: 700 16px/1.2 var(--font-ui); }
.run-menu summary::-webkit-details-marker { display: none; }
.tokens li { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; }
.run-menu[open] { flex-basis: 100%; }
.rename, .rename-form { display: grid; gap: 6px; }
.rename-open, .rename-clear { width: fit-content; }
.rename-form label { display: grid; gap: 4px; font-size: 12px; color: var(--color-muted); }
.rename-form input { padding: 6px 8px; border: var(--shape-border) solid var(--color-line); border-radius: calc(var(--shape-radius) / 2); background: var(--color-surface); color: var(--color-ink); font: inherit; }
.rename-message { margin: 0; font-size: 12px; }
.run-name { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; margin: 0; }
.name-title { font: 700 18px/1.3 var(--font-heading); }
.name-label, .need-label, .card-label { font-weight: 700; }
.name-pull, .card-pull, .token-pull { color: var(--color-muted); }
.card-ids { display: flex; gap: 6px; font: 400 12px/1.6 var(--font-ui); }
.token-pull { padding: 6px 0 6px 6px; }
.run-notes ul { margin: 0; padding: 0; list-style: none; }
.note-text { margin: 4px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.need-action { flex-shrink: 0; padding: 8px 18px; border: 0; cursor: pointer; background: var(--color-panel); color: var(--color-ink); font: 600 14px/1.4 var(--font-ui); text-decoration: none; white-space: nowrap; clip-path: var(--angled); }
.need-action:hover { background: var(--color-line); }
.need-action:disabled { cursor: progress; opacity: 0.6; }
.need-decision .need-action { background: var(--color-state-attention); color: var(--on-lamp); }
.need-decision .need-action:hover { background: color-mix(in srgb, var(--color-state-attention) 85%, #000000); }
.need-action:focus-visible { clip-path: none; }
.legend { display: flex; flex-wrap: wrap; gap: 6px 16px; list-style: none; margin: 0; padding: 0; color: var(--color-muted); font-size: 13px; }
.legend li { display: inline-flex; align-items: center; gap: 8px; }
.lines { list-style: none; margin: 0; padding: 0; }
.repositories { list-style: none; margin: 0; padding: 0; }
.repository { border-top: var(--shape-border) solid var(--color-line); }
.repository:first-child { border-top: 0; }
.repository-name { display: inline-block; margin: 12px 8px 4px 18px; font: 700 15px/1.3 var(--font-heading); }
.repository-down { color: var(--color-muted); font-size: 12px; }
.line { display: grid; grid-template-columns: 180px minmax(0, 1fr) 170px; border-top: var(--shape-border) solid var(--color-line); }
.line:first-child { border-top: 0; }
.line:nth-child(4n+1), .line-color-1 { --line-color: var(--line-1); }
.line:nth-child(4n+2), .line-color-2 { --line-color: var(--line-2); }
.line:nth-child(4n+3), .line-color-3 { --line-color: var(--line-3); }
.line:nth-child(4n), .line-color-4 { --line-color: var(--line-4); }
.line-name { position: relative; display: flex; flex-direction: column; gap: 2px; min-width: 0; padding: 16px 16px 16px 32px; overflow-wrap: anywhere; }
.line-name::before { content: ""; position: absolute; left: 18px; top: 16px; bottom: 16px; width: 5px; background: var(--line-color); clip-path: polygon(0 4px, 100% 0, 100% 100%, 0 100%); }
.line-name a { color: var(--color-ink); font: 700 17px/1.3 var(--font-heading); text-decoration: none; }
.line-name a:hover { text-decoration: underline; }
.line-active { color: var(--color-muted); font-size: 13px; }
.line-track { min-width: 0; overflow-x: auto; overscroll-behavior-x: contain; padding: 16px 20px; background: var(--color-panel); }
.stations { display: flex; justify-content: flex-start; width: max-content; list-style: none; margin: 0; padding: 0; }
.station { position: relative; flex: 0 0 var(--station-width); display: flex; flex-direction: column; align-items: flex-start; gap: 6px; padding-right: 12px; }
.station:not(:last-child)::after { content: ""; position: absolute; top: 10px; left: 11px; width: 100%; height: 2px; background: var(--color-muted); opacity: 0.45; }
.lamp { position: relative; z-index: 1; display: inline-block; flex-shrink: 0; width: 14px; height: 14px; margin: 4px; transform: rotate(45deg); background: var(--state, var(--color-surface)); box-shadow: inset 0 0 0 2px var(--color-muted); }
.lamp.running, .token.running { --state: var(--color-state-running); }
.lamp.waiting, .token.waiting { --state: var(--color-state-waiting); }
.lamp.needs-you, .token.needs-you { --state: var(--color-state-attention); }
.lamp.stopped, .token.stopped { --state: var(--color-state-failed); }
.lamp.running, .lamp.needs-you { box-shadow: 0 0 0 4px color-mix(in srgb, var(--state) 22%, transparent); }
.lamp.waiting, .lamp.stopped { box-shadow: none; }
.station-name { color: var(--color-muted); font-size: 13px; overflow-wrap: anywhere; }
.station:not(.empty) .station-name { color: var(--color-ink); font-weight: 600; }
.tokens { display: flex; flex-direction: column; gap: 6px; list-style: none; margin: 2px 0 0; padding: 0; }
.token { display: inline-flex; align-items: stretch; color: var(--color-ink); text-decoration: none; font: 500 13px/1.2 var(--font-ui); font-variant-numeric: tabular-nums; white-space: nowrap; background: color-mix(in srgb, var(--state) 18%, var(--color-surface)); clip-path: var(--angled); }
.token:hover { background: color-mix(in srgb, var(--state) 30%, var(--color-surface)); }
.token-worker { display: grid; place-items: center; min-width: 26px; padding: 6px; background: var(--state); color: var(--on-lamp); font-weight: 700; }
.token.waiting .token-worker { color: var(--on-waiting); }
.token-ticket { padding: 6px 0 6px 10px; }
.token-time { padding: 6px 12px 6px 8px; color: var(--color-muted); }
.line-end { display: flex; flex-direction: column; align-items: flex-end; justify-content: center; gap: 2px; min-width: 0; padding: 16px 20px; border-left: var(--shape-border) dashed var(--color-line); color: var(--color-muted); font-size: 13px; text-align: right; }
.line-ready { color: var(--color-ink); font-weight: 600; font-variant-numeric: tabular-nums; }
.line-wait { font-variant-numeric: tabular-nums; }
.shelf { min-width: 0; margin-top: var(--size-gap); background: var(--color-surface); box-shadow: inset 0 0 0 var(--shape-border) var(--color-line); }
.shelf-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px 16px; padding: 12px 20px; }
.shelf-head h2 { margin: 0; font-size: 18px; }
.shelf-count { color: var(--color-muted); font-size: 13px; font-variant-numeric: tabular-nums; }
.shelf > .meta { margin: 0; padding: 0 20px 16px; }
.tiles { display: flex; gap: 16px; list-style: none; margin: 0; padding: 0 20px 16px; overflow-x: auto; overscroll-behavior-x: contain; }
.tile { flex: 0 0 320px; display: flex; flex-direction: column; gap: 6px; padding: 14px 16px; border-left: 5px solid var(--line-color, var(--color-muted)); background: var(--color-panel); clip-path: polygon(0 0, 100% 0, 100% calc(100% - var(--shape-cut)), calc(100% - var(--shape-cut)) 100%, 0 100%); }
.tile-ids { display: flex; gap: 10px; font-variant-numeric: tabular-nums; }
.tile-ticket { font-weight: 700; }
.tile-pull { color: var(--color-muted); }
.tile-title { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; overflow-wrap: anywhere; color: var(--color-ink); font: 700 15px/1.35 var(--font-heading); text-decoration: none; }
.tile-title:hover { text-decoration: underline; }
.tile-facts { display: flex; flex-wrap: wrap; gap: 2px 14px; color: var(--color-muted); font-size: 13px; font-variant-numeric: tabular-nums; }
.tile-demo { display: inline-flex; align-items: center; gap: 10px; width: fit-content; margin: 4px 0 0; padding: 0; background: none; clip-path: none; color: var(--color-ink); font: 600 14px/1.5 var(--font-ui); }
.tile-demo:hover { text-decoration: underline; }
.demo-frame { width: 72px; height: 40px; object-fit: cover; background: var(--color-code-background); box-shadow: 0 0 0 1px var(--color-line); }
.demo-player { padding: 0; border: 0; background: var(--color-code-background); box-shadow: var(--shadow); }
.demo-player::backdrop { background: rgba(0,0,0,0.6); }
.demo-player video { display: block; width: min(960px, 92vw); max-height: 85dvh; }
.board { width: 100%; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.columns { display: flex; align-items: flex-start; gap: ${String(boardSizing.gap)}px; flex: 1; min-height: 0; overflow-x: scroll; overflow-y: hidden; padding: 6px 6px 12px; scrollbar-color: var(--color-muted) var(--color-panel); }
@supports selector(::-webkit-scrollbar) { .columns { scrollbar-color: auto; } }
.columns::-webkit-scrollbar { height: 12px; }
.columns::-webkit-scrollbar-track { background: var(--color-panel); }
.columns::-webkit-scrollbar-thumb { background: var(--color-muted); border-radius: calc(var(--shape-radius) / 2); }
.column { flex: 1 0 ${String(boardSizing.minimumColumnWidth)}px; min-width: ${String(boardSizing.minimumColumnWidth)}px; max-height: 100%; display: flex; flex-direction: column; overflow: hidden; padding: 10px; border-radius: var(--shape-radius); box-shadow: inset 0 0 0 var(--shape-border) var(--color-line); background: var(--color-panel); }
.column-name { display: flex; align-items: center; gap: 6px; flex-shrink: 0; margin: 0; padding: 4px 0 10px; color: var(--color-muted); font: 600 13px/1.5 var(--font-ui); }
.column-count { font-variant-numeric: tabular-nums; }
.column-name > span:first-child { flex: 1; }
.column-cards { min-height: 0; overflow-y: auto; overscroll-behavior-y: contain; }
.column.collapsed { flex: 0 0 ${String(boardSizing.collapsedColumnWidth)}px; min-width: ${String(boardSizing.collapsedColumnWidth)}px; padding: 6px; }
.collapsed .column-name { writing-mode: vertical-rl; padding: 0; }
header button, .phone button, .column-name button, .add-card, .add-card-form button { font: 500 13px/1.4 var(--font-ui); color: var(--color-ink); background: var(--color-panel); margin: 0; }
header button:hover, .phone button:hover, .column-name button:hover, .add-card:hover, .add-card-form button:hover { background: var(--color-line); }
.add-card, .add-card-form button { color: var(--color-ink); margin: 4px 8px 4px 0; }
.add-card { width: 100%; text-align: left; margin: 4px 0; }
.add-card-form { padding: 8px 0; overflow-wrap: anywhere; }
.add-card-form label { display: block; color: var(--color-ink); margin-bottom: 8px; }
.add-card-form input, .add-card-form textarea { display: block; width: 100%; min-width: 0; box-sizing: border-box; padding: 8px; border: var(--shape-border) solid var(--color-line); border-radius: calc(var(--shape-radius) / 2); font: inherit; color: var(--color-ink); background: var(--color-surface); }
.add-card-form textarea { resize: vertical; }
.add-card-form button:disabled { opacity: 0.6; cursor: default; }
.add-card-form p { font-size: 12px; margin: 8px 0; }
.card { display: grid; gap: 6px; margin-bottom: 10px; padding: 12px; border-radius: var(--shape-radius); box-shadow: inset 0 0 0 var(--shape-border) var(--color-line); color: var(--color-ink); overflow-wrap: anywhere; background: var(--color-surface); }
.card:hover { outline: var(--shape-border) solid var(--color-accent-strong); }
.card-run { display: grid; gap: 4px; min-width: 0; color: inherit; text-decoration: none; }
.card-run strong { font-family: var(--font-heading); font-weight: 700; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
.completion-mark { font-size: 12px; }
.card-step, .card-review, .card-cost { font: 400 12px/1.6 var(--font-ui); font-variant-numeric: tabular-nums; }
.card small { font: 400 11px/1.6 var(--font-code); }
.card-step, .card-review { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.card-step { color: var(--color-muted); }
.card-step.active { color: var(--color-accent-strong); }
.card-review { color: var(--color-muted); }
.review-pill { display: inline-block; padding: 1px 5px; border-radius: calc(var(--shape-radius) / 2); box-shadow: inset 0 0 0 var(--shape-border) var(--color-line); }
.decision-mark { width: fit-content; padding: 3px 7px; border-radius: calc(var(--shape-radius) / 2); background: linear-gradient(var(--warn-tint), var(--warn-tint)), var(--color-surface); color: var(--color-warn); font: 600 12px/1.6 var(--font-ui); }
.column.stopped { background: var(--color-surface); box-shadow: inset 0 0 0 var(--shape-border) var(--color-bad), inset 0 0 0 100vmax var(--bad-tint); }
.column.stopped.collapsed { background: var(--color-panel); box-shadow: inset 0 0 0 var(--shape-border) var(--color-line); }
.stopped .column-name { color: var(--color-bad); background: var(--color-surface); border-radius: calc(var(--shape-radius) / 2); }
.stopped .card { background: linear-gradient(var(--bad-tint), var(--bad-tint)), var(--color-surface); box-shadow: inset 0 0 0 var(--shape-border) var(--color-bad); }
.back { display: block; width: fit-content; margin: 16px 0; }
.icon { font-weight: 700; color: var(--color-muted); }
.good .icon, .phase.done .mark, p.good { color: var(--color-accent-strong); }
.bad .icon, .phase.failed .mark, .bad, .down { color: var(--color-bad); }
.attention .icon { color: var(--color-warn); }
.working .icon, .phase.active .mark, .banner.working h2 { color: var(--color-accent-strong); }
.banner { position: sticky; top: 0; z-index: 1; display: flex; gap: 12px; background: var(--color-surface); box-shadow: var(--shadow); border: var(--shape-border) solid var(--color-line); border-left: 6px solid var(--color-muted); border-radius: var(--shape-radius); padding: 14px; }
.banner.good, .banner.working { border-left-color: var(--color-accent-strong); }
.banner.bad { border-left-color: var(--color-bad); }
.banner.attention { border-left-color: var(--color-warn); }
.banner div { min-width: 0; flex: 1; }
.banner .icon { font-size: 22px; line-height: 1.2; }
.banner h2 { margin: 0; font-size: 20px; line-height: 1.45; }
.banner .name { font: 400 13px/1.5 var(--font-ui); color: var(--color-muted); margin-left: 6px; }
.banner p { margin: 2px 0 0; }
.now { display: block; color: var(--color-muted); font: 12px/1.6 var(--font-code); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.banner p, .phase .time, h3 { font-variant-numeric: tabular-nums; }
.phases { display: flex; gap: 8px; list-style: none; margin: 18px 0 4px; padding: 12px; border-radius: var(--shape-radius); background: var(--color-surface); box-shadow: inset 0 0 0 var(--shape-border) var(--color-line); overflow-x: auto; }
.phase { flex: 1; min-width: 110px; display: grid; grid-template-columns: auto 1fr; column-gap: 7px; border-top: 2px solid var(--color-line); padding-top: 10px; color: var(--color-muted); font: 400 12px/1.6 var(--font-code); }
.phase .mark { display: grid; place-items: center; width: 24px; height: 24px; border-radius: 50%; box-shadow: inset 0 0 0 var(--shape-border) var(--color-line); }
.phase.done, .phase.active, .phase.failed { color: var(--color-ink); }
.phase.done, .phase.active { border-top-color: var(--color-accent-strong); }
.phase.active { font-weight: 500; }
.phase.active .mark { background: var(--accent-tint); }
.phase.failed { border-top-color: var(--color-bad); }
.phase .time { grid-column: 2; color: var(--color-muted); font-weight: 400; min-height: 18px; }
h3 { margin: 22px 0 6px; font-size: 16px; }
.meta { color: var(--color-muted); margin: 2px 0; font-size: 12px; overflow-wrap: anywhere; }
.foot { margin-top: 18px; }
.decision { background: var(--color-surface); box-shadow: var(--shadow); border: var(--shape-border) solid var(--color-warn); border-radius: var(--shape-radius); padding: 2px 14px 12px; margin-top: 18px; }
.decision h3 { margin-top: 10px; }
.decision .request { white-space: pre-wrap; overflow-wrap: anywhere; }
.decision-replies { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0; }
.decision-answer { display: grid; gap: 6px; margin: 10px 0; }
.decision-answer label { display: grid; gap: 4px; font-size: 12px; color: var(--color-muted); }
.decision-answer textarea { padding: 6px 8px; border: var(--shape-border) solid var(--color-line); border-radius: calc(var(--shape-radius) / 2); background: var(--color-surface); color: var(--color-ink); font: inherit; }
.decision-answer button { justify-self: start; }
.decision-reply { margin: 12px 0 0; font-weight: 600; }
.need-reason { margin: 4px 0 0; font-size: 13px; }
.review { border-left: 3px solid var(--color-bad); padding: 0 12px; margin-top: 10px; }
.review p { white-space: pre-wrap; }
.fact, p.good, p.bad { margin: 8px 0 4px; }
.report { white-space: pre-wrap; margin: 6px 0; max-height: 300px; overflow: auto; border-left: 3px solid var(--color-line); padding-left: 10px; }
pre, code, .activity, .events { font: 400 12px/1.6 var(--font-code); }
pre { background: var(--color-code-background); color: var(--color-code-text); white-space: pre-wrap; overflow-wrap: anywhere; border: var(--shape-border) solid var(--color-code-line); border-radius: calc(var(--shape-radius) / 2); padding: 10px; margin: 4px 0; }
details { margin: 6px 0; }
summary { cursor: pointer; color: var(--color-muted); }
.code-window { background: var(--color-code-background); color: var(--color-code-text); border-radius: var(--shape-radius); box-shadow: inset 0 0 0 var(--shape-border) var(--color-code-line), var(--shadow); overflow-wrap: anywhere; }
.code-head { background: var(--color-code-header); color: var(--color-code-text); padding: 10px 12px; border-bottom: var(--shape-border) solid var(--color-code-line); border-radius: var(--shape-radius) var(--shape-radius) 0 0; font: 500 12px/1.6 var(--font-code); }
.turn { margin-top: 22px; }
.turn h3 { margin: 0; }
.turn .meta { padding: 8px 12px; color: var(--color-code-muted); }
.activity { padding: 4px 12px 12px; }
.code-window summary, .code-window .event, .code-window .item.tool { color: var(--color-code-muted); }
.code-window .bad, .code-window .item.error { color: #FF7B72; }
.code-window .item.error { border-left-color: #FF7B72; }
.code-window .item.result { color: var(--color-accent); border-left-color: var(--color-accent); }
.command { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: center; margin: 10px 0; padding-bottom: 10px; }
.command .label { grid-column: 1 / -1; }
.command code { min-width: 0; padding-left: 12px; overflow-wrap: anywhere; white-space: pre-wrap; }
button { font: 500 12px/1.6 var(--font-code); border: 0; border-radius: 0; background: var(--color-code-line); color: var(--color-code-text); clip-path: var(--angled); padding: 5px 12px; margin-right: 10px; cursor: pointer; }
button:hover { background: var(--color-code-header); }
button:focus-visible, .token:focus-visible { clip-path: none; }
.item { white-space: pre-wrap; overflow-wrap: anywhere; padding: 1px 0 1px 10px; border-left: 3px solid transparent; }
.item.say { border-left-color: var(--color-code-line); margin: 8px 0; font: 14px/1.5 var(--font-ui); }
.item.tool { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.item.result { margin: 8px 0; font: 500 14px/1.5 var(--font-ui); }
.tools summary { display: flex; gap: 10px; }
.tools summary::before { content: "▸"; }
.tools[open] summary::before { content: "▾"; }
.last { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tools[open] .last { display: none; }
.event { padding: 1px 12px; }
.events { margin-top: 18px; padding-bottom: 10px; }
.events > summary { color: var(--color-code-text); }
.down { font-weight: 600; }
.version { position: fixed; left: 12px; bottom: 8px; font: 12px/1.4 var(--font-code); color: var(--color-muted); pointer-events: none; }
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
