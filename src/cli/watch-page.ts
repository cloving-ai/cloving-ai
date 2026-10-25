import { cardReply } from "./watch-card-reply.ts";
import { record } from "../protocol.ts";
import { Commands, commandText } from "./command-effects.ts";
import { watchCardClient } from "./watch-card-client.ts";
import {
  AddCard,
  CardInput,
  cardKey,
  cardSubmitKey,
} from "./watch-card-view.ts";
import { watchClient } from "./watch-client.ts";
import { watchPhoneClient } from "./watch-phone-client.ts";
import {
  PhoneAsk,
  PhoneCode,
  PhoneList,
  PhonePanel,
  phoneButton,
  phoneNotices,
  refusalText,
  timeLeft,
} from "./watch-phone-view.ts";
import { priceOf, tokenCount, usageOf } from "../worker-usage.ts";
import { priceText, usageText, totalsSuffix } from "./usage-render.ts";
import { startPrompts, StartCard, StartRun } from "./watch-start-view.ts";
import {
  Board,
  boardSizing,
  Card,
  HandoffLinks,
  Column,
  columnCollapsed,
  CardReview,
  WorkflowList,
  cardReview,
  cardStep,
  completionMark,
  observationText,
  staleObservation,
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
  BoardPage,
  Header,
  Page,
  Phases,
  PullRequest,
  Review,
  RefusedWorkflows,
  Queue,
  Run,
} from "./watch-view.ts";

const functions = [
  record,
  commandText,
  Commands,
  Queue,
  cardReply,
  cardSubmitKey,
  cardKey,
  AddCard,
  CardInput,
  priceOf,
  tokenCount,
  usageOf,
  priceText,
  usageText,
  totalsSuffix,
  watchHash,
  watchLocation,
  boardWorkflow,
  watchTitle,
  cardReview,
  cardStep,
  completionMark,
  observationText,
  staleObservation,
  CardReview,
  Card,
  HandoffLinks,
  Column,
  columnCollapsed,
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
  startPrompts,
  StartCard,
  StartRun,
  BannerDetail,
  Banner,
  Phases,
  PullRequest,
  Review,
  Run,
  timeLeft,
  refusalText,
  phoneButton,
  phoneNotices,
  PhoneCode,
  PhoneAsk,
  PhoneList,
  PhonePanel,
  Header,
  RefusedWorkflows,
  BoardPage,
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
.start-run { flex-shrink: 0; max-height: 45dvh; overflow-y: auto; }
.workflow-refusals { flex-shrink: 0; max-height: 25dvh; overflow-y: auto; overflow-wrap: anywhere; }
.workflow-refusals h2 { margin: 8px 0; }
a { color: var(--accent-strong); }
.phone { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; margin: 0 0 12px; }
.phone button { color: var(--ink); box-shadow: inset 0 0 0 1px var(--line); margin: 0; }
.phone-pairing div { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; }
.phone-qr { width: 196px; height: 196px; border-radius: 8px; }
.phone-ask { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.phone-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.phone-list li { display: flex; gap: 8px; align-items: center; }
header { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; padding: 22px 0 10px; color: var(--muted); font-size: 12px; }
.brand { display: inline-flex; align-items: center; gap: 9px; color: var(--ink); font: 800 26px/1.2 var(--heading-font); }
.brand svg { width: 30px; height: 30px; color: var(--accent); }
a:focus-visible, button:focus-visible, summary:focus-visible, input:focus-visible, textarea:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; box-shadow: 0 0 0 6px var(--code-bg); }
h2, h3 { font-family: var(--heading-font); font-weight: 700; }
.start-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr)); gap: 16px; margin-top: 12px; }
.start-card { min-width: 0; padding: 14px; border-radius: 14px; background: var(--surface); box-shadow: inset 0 0 0 1px var(--line); }
.start-card h3 { margin: 0; }
.start-card p { margin: 6px 0 12px; }
.start-card .command { grid-template-columns: minmax(0, 1fr); margin: 0; }
.start-card button { justify-self: end; }
.workspace { display: flex; width: 100%; margin-top: 12px; flex: 1; min-height: 0; }
.workflows { display: flex; flex-direction: row; flex-shrink: 0; gap: 8px; min-width: 0; margin-top: 12px; padding: 6px; overflow-x: auto; overflow-y: hidden; }
.workflows a { display: grid; flex-shrink: 0; white-space: nowrap; gap: 2px; border-bottom: 3px solid transparent; padding: 10px; color: inherit; text-decoration: none; }
.workflows a[aria-current="page"] { border-bottom-color: var(--accent); background: var(--surface); border-radius: 8px 8px 0 0; }
.workflows span, .card small { color: var(--muted); font-size: 12px; }
.board { width: 100%; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.board h2 { margin: 0 0 8px; font-size: 24px; flex-shrink: 0; }
.columns { display: flex; align-items: flex-start; gap: ${String(boardSizing.gap)}px; flex: 1; min-height: 0; overflow-x: scroll; overflow-y: hidden; padding: 6px 6px 12px; scrollbar-color: var(--muted) var(--surface-2); }
@supports selector(::-webkit-scrollbar) { .columns { scrollbar-color: auto; } }
.columns::-webkit-scrollbar { height: 12px; }
.columns::-webkit-scrollbar-track { background: var(--surface-2); }
.columns::-webkit-scrollbar-thumb { background: var(--muted); border-radius: 6px; }
.column { flex: 1 0 ${String(boardSizing.minimumColumnWidth)}px; min-width: ${String(boardSizing.minimumColumnWidth)}px; max-height: 100%; display: flex; flex-direction: column; overflow: hidden; padding: 10px; border-radius: 14px; box-shadow: inset 0 0 0 1px var(--line); background: var(--surface-2); }
.column-name { display: flex; align-items: center; gap: 6px; flex-shrink: 0; margin: 0; padding: 4px 0 10px; color: var(--muted); font: 500 12px/1.5 var(--code-font); }
.column-name > span:first-child { flex: 1; }
.column-cards { min-height: 0; overflow-y: auto; overscroll-behavior-y: contain; }
.column.collapsed { flex: 0 0 ${String(boardSizing.collapsedColumnWidth)}px; min-width: ${String(boardSizing.collapsedColumnWidth)}px; padding: 6px; }
.collapsed .column-name { writing-mode: vertical-rl; padding: 0; }
.column-name button, .start-toggle { color: var(--ink); box-shadow: inset 0 0 0 1px var(--line); margin: 0; }
.column-name button:hover, .start-toggle:hover, .add-card:hover, .add-card-form button:hover { background: var(--surface); }
.add-card, .add-card-form button { color: var(--ink); box-shadow: inset 0 0 0 1px var(--line); margin: 4px 8px 4px 0; }
.add-card { width: 100%; text-align: left; }
.add-card-form { padding: 8px 0; overflow-wrap: anywhere; }
.add-card-form label { display: block; color: var(--ink); margin-bottom: 8px; }
.add-card-form input, .add-card-form textarea { display: block; width: 100%; min-width: 0; box-sizing: border-box; padding: 8px; border: 1px solid var(--line); border-radius: 6px; font: inherit; color: var(--ink); background: var(--surface); }
.add-card-form textarea { resize: vertical; }
.add-card-form button:disabled { opacity: 0.6; cursor: default; }
.add-card-form p { font-size: 12px; margin: 8px 0; }
.card { display: grid; gap: 6px; margin-bottom: 10px; padding: 12px; border-radius: 14px; box-shadow: inset 0 0 0 1px var(--line), var(--shadow); color: var(--ink); overflow-wrap: anywhere; background: var(--surface); }
.card:hover { outline: 1px solid var(--accent-strong); }
.card-run { display: grid; gap: 4px; min-width: 0; color: inherit; text-decoration: none; }
.card-run strong { font-family: var(--heading-font); font-weight: 700; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
.completion-mark { font-size: 12px; }
.card-step, .card-review, .card-cost, .card small { font: 400 12px/1.6 var(--code-font); font-variant-numeric: tabular-nums; }
.card-step, .card-review { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
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
@media (max-width: 700px) { body { padding-inline: 12px; } }
`;

export function pageDocument(actionToken: string | null = null): string {
  const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${clove.viewBox}">${clove.paths.map((d) => `<path fill="#0BBF64" d="${d}"/>`).join("")}</svg>`;
  const script = [
    'import { h as element, h as component, render } from "./preact.mjs";',
    `const clove = ${JSON.stringify(clove)};`,
    `const actionToken = ${JSON.stringify(actionToken)};`,
    ...functions.map((item) => item.toString()),
    watchCardClient,
    watchPhoneClient,
    watchClient,
  ].join("\n");
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Cloving</title>',
    `<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(icon)}">`,
    `<style>${style}</style></head><body>`,
    '<div id="app"></div>',
    `<script type="module">${script}</script></body></html>`,
    "",
  ].join("\n");
}
