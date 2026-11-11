import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { component } from "../src/cli/watch-element.ts";
import type { WatchModel, WatchRun } from "../src/cli/watch-render.ts";
import type { RunCommandControls } from "../src/cli/watch-run-command-view.ts";
import type { SteerControls } from "../src/cli/watch-steer-view.ts";
import type { RenameControls } from "../src/cli/watch-rename-view.ts";
import { Page } from "../src/cli/watch-view.ts";
import { found, rendered } from "./watch-dom.ts";
import { renameControls, type RenameCalls } from "./watch-rename-fixture.ts";
import { rule, rules } from "./watch-style-fixture.ts";
import {
  at,
  noCopy,
  phases,
  sampleModel,
  sampleRun,
  sampleTurn,
} from "./watch-sample.ts";

const quiet =
  "No observation arrived in the liveness period. Silence alone is not a failure.";

const working = sampleRun({
  runId: "run-7",
  state: "running",
  code: "no-recent-observation",
  detail: quiet,
  decisions: [],
  label: "#726",
  title: "Find commit signatures",
  phases: phases(["done", "done", "active"]),
  turns: [
    sampleTurn({ activity: [{ kind: "say", text: "I run the tests." }] }),
  ],
  pullRequest: {
    number: 732,
    url: "https://github.com/cloving-ai/cloving-ai/pull/732",
  },
  reviews: [
    { round: 1, score: 4, commit: "0ff2f41aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    { round: 2, score: 3, commit: "ca90684aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
  ],
  claudeCostUsd: 9.24,
  chain: { position: 1, limit: 5 },
});

const bare = sampleRun({
  runId: "run-8",
  state: "running",
  code: "run-running",
  detail: "The run is in work.",
  decisions: [],
  turns: [],
  claudeCostUsd: null,
  phases: phases(["done", "done", "active"]),
});

function model(): WatchModel {
  return {
    ...sampleModel([working, bare]),
    queue: {
      state: "running",
      busy: 1,
      lanes: 3,
      skipped: [{ ticketId: "234", reason: "ticket-active" }],
    },
  };
}

interface Controls {
  readonly renaming?: RenameControls;
  readonly controlling?: RunCommandControls;
  readonly steering?: SteerControls;
}

function page(run: WatchRun, controls: Controls = {}) {
  return component(Page, {
    model: model(),
    selected: `run=${run.runId}`,
    now: at("21:34:41"),
    stale: false,
    copying: noCopy,
    ...controls,
  });
}

function commands(calls: string[]): RunCommandControls {
  return {
    busy: [],
    messages: {},
    asking: null,
    onCommand: (runId, command) => calls.push(`${command} ${runId}`),
    onAsk: (runId, place) => calls.push(`ask ${runId} ${place}`),
    onKeep: () => calls.push("keep"),
  };
}

function steers(
  calls: string[],
  changes: Partial<SteerControls> = {},
): SteerControls {
  return {
    open: null,
    note: "",
    now: false,
    busy: [],
    messages: {},
    onOpen: (runId) => calls.push(`steer ${runId}`),
    onClose: () => undefined,
    onNote: () => undefined,
    onNow: () => undefined,
    onSend: () => undefined,
    ...changes,
  };
}

function all(calls: string[]): Controls {
  return {
    renaming: renameControls({
      opened: [],
      saved: [],
      cleared: [],
      closed: [],
    }),
    controlling: commands(calls),
    steering: steers(calls),
  };
}

function banner(html: string): string {
  const start = html.indexOf('<section class="banner');
  return html.slice(start, html.indexOf("</section>", start));
}

function click(node: Readonly<Record<string, unknown>> | undefined): void {
  const handler = node?.["onClick"];
  assert.ok(typeof handler === "function");
  Reflect.apply(handler, undefined, []);
}

await test("CLV-357 the banner holds the back link, the state icon, the label and the title, and one action bar with Steer, Pause and a ⋯ menu that holds Rename and Drop", () => {
  const html = banner(rendered(page(working, all([]))));
  assert.match(
    html,
    /^<section class="banner working"><a class="banner-back" href="#">← Floor<\/a><span class="icon">●<\/span><div class="banner-main"><h2 class="run-identity"><span class="name-label">#726<\/span><span class="name-title">Find commit signatures<\/span><button type="button" class="name-edit" title="Rename" aria-label="Rename">✎<\/button><\/h2>/,
  );
  const bar = html.slice(html.indexOf('<div class="run-head-actions">'));
  assert.match(
    bar,
    /^<div class="run-head-actions"><button type="button" class="steer-open">Steer<\/button><button type="button" class="run-command-pause">Pause<\/button><div class="run-more">/,
  );
  const menu = bar.slice(bar.indexOf('<div class="run-more-menu"'));
  assert.match(
    menu,
    /^<div class="run-more-menu" aria-label="More run controls"><button type="button" class="rename-open">Rename<\/button><hr class="run-more-split">(?:<\/hr>)?<button type="button" class="run-command-drop">Drop<\/button><\/div>/,
  );
  assert.equal(html.match(/run-command-drop/g)?.length, 1);
  assert.equal(html.match(/rename-open/g)?.length, 1);
});

await test("CLV-357 the status line shows the state, the current phase and its time, and a reason shows in plain words without its code", () => {
  const html = banner(rendered(page(working)));
  assert.match(
    html,
    /<p class="run-status">In work · Agent turn · 8 min 39 s<\/p><p class="banner-detail">The worker works for 8 min 39 s · 0 tool calls · last output 4 min 21 s ago<span class="now">I run the tests\.<\/span><\/p>/,
  );
  const plain = banner(rendered(page(bare)));
  assert.match(plain, /<p class="banner-detail">The run is in work\.<\/p>/);
  assert.doesNotMatch(plain, /run-running/);
});

await test("CLV-357 the facts line shows the pull request with the latest review score, the cost and the chain position, and a run with no turn and no cost shows no unknown facts above the tabs", () => {
  const html = rendered(page(working));
  assert.match(
    html,
    /<p class="run-facts"><a href="https:\/\/github\.com\/cloving-ai\/cloving-ai\/pull\/732">PR #732<\/a> · review 3\/5 · 9\.24 USD · run 1 of 5<\/p>/,
  );
  const plain = rendered(page(bare));
  const head = plain.slice(0, plain.indexOf('class="run-tabs"'));
  assert.doesNotMatch(head, /not known|run-facts/);
});

await test("CLV-357 the run page has five tabs, Details holds the totals, the reason, the IDs, the effect units and the chain, and the page has no queue details and no footer line", () => {
  const html = rendered(page(working));
  assert.deepEqual(
    [...html.matchAll(/<button[^>]*role="tab"[^>]*>([^<]*)<\/button>/g)].map(
      (match) => match[1],
    ),
    ["Transcript", "Agent turn", "Pull request", "Events (2)", "Details"],
  );
  const details = html.slice(html.indexOf('id="run-panel-details"'));
  for (const part of [
    "Run totals so far",
    "9.24 USD",
    "no-recent-observation: " + quiet,
    "run-7",
    "clv-016-a6f7ef47",
    "develop-ticket",
    "1 of 8 effect units",
    "run 1 of 5",
  ])
    assert.ok(details.includes(part), part);
  const pull = html.slice(
    html.indexOf('id="run-panel-pull"'),
    html.indexOf('id="run-panel-events"'),
  );
  assert.match(pull, /Round 1 · Review 4\/5 · commit 0ff2f41/);
  assert.doesNotMatch(html, /queue-waiting|meta foot/);
  assert.match(html, /1 of 3 lanes busy/);
  const none = rendered(page(bare));
  assert.match(
    none.slice(none.indexOf('id="run-panel-transcript"')),
    /^id="run-panel-transcript"[^>]*><p class="meta">No agent turn for this run\.<\/p>/,
  );
});

await test("CLV-357 the pencil and the menu open the rename, the form sits in the banner, Enter saves and Escape cancels", () => {
  const recorded: RenameCalls = {
    opened: [],
    saved: [],
    cleared: [],
    closed: [],
  };
  const closed = page(working, { renaming: renameControls(recorded) });
  const pencil = found(closed, "button").find(
    (node) => node["class"] === "name-edit",
  );
  click(pencil);
  assert.deepEqual(recorded.opened, [
    { runId: "run-7", title: "Find commit signatures", label: "#726" },
  ]);
  const open = page(working, {
    renaming: renameControls(recorded, {
      open: "run-7",
      title: "Find commit signatures",
      label: "#726",
    }),
  });
  const html = banner(rendered(open));
  assert.match(html, /<div class="banner-main"><form class="rename-form">/);
  const form = found(open, "form").find(
    (node) => node["class"] === "rename-form",
  );
  const submit = form?.["onSubmit"];
  const keyDown = form?.["onKeyDown"];
  assert.ok(typeof submit === "function" && typeof keyDown === "function");
  Reflect.apply(submit, undefined, [{ preventDefault: () => undefined }]);
  Reflect.apply(keyDown, undefined, [
    {
      key: "Escape",
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
    },
  ]);
  assert.deepEqual(recorded.saved, ["run-7"]);
  assert.deepEqual(recorded.closed, [1]);
});

await test("CLV-357 Drop in the menu asks under the banner, and the steer form and the replies show under the banner, not in the bar", () => {
  const calls: string[] = [];
  const tree = page(working, all(calls));
  click(
    found(tree, "button").find((node) => node["class"] === "run-command-drop"),
  );
  click(found(tree, "button").find((node) => node["class"] === "steer-open"));
  assert.deepEqual(calls, ["ask run-7 detail", "steer run-7"]);
  const asked = rendered(
    page(working, {
      controlling: {
        ...commands([]),
        asking: { runId: "run-7", place: "detail" },
        messages: { "run-7": { command: "pause", text: "Paused." } },
      },
      steering: steers([], { open: "run-7", messages: { "run-7": "Sent." } }),
    }),
  );
  const after = asked.slice(asked.indexOf("</section>"));
  assert.match(
    after,
    /^<\/section><div class="run-command" data-run="run-7" data-place="detail"><p class="drop-question">/,
  );
  assert.match(
    after,
    /<p class="run-command-message" role="status">Paused\.<\/p>/,
  );
  assert.match(after, /<div class="steer"><form class="steer-form"/);
  assert.match(after, /<p class="steer-message" role="status">Sent\.<\/p>/);
  assert.doesNotMatch(banner(asked), /steer-form|drop-question/);
});

function menuElement() {
  const attributes = new Set<string>();
  return {
    attributes,
    setAttribute: (name: string) => {
      attributes.add(name);
    },
    removeAttribute: (name: string) => {
      attributes.delete(name);
    },
  };
}

await test("CLV-357 a pick in the ⋯ menu or Escape closes the menu at once, and the menu opens again when the pointer leaves or enters or the focus comes back", () => {
  const more = found(page(working, all([])), "div").find(
    (node) => node["class"] === "run-more",
  );
  assert.ok(more !== undefined);
  const box = menuElement();
  const fire = (name: string, event: Readonly<Record<string, unknown>>) => {
    const handler = more[name];
    assert.ok(typeof handler === "function", name);
    Reflect.apply(handler, undefined, [{ currentTarget: box, ...event }]);
  };
  const held = () => [...box.attributes];
  fire("onClick", {});
  assert.deepEqual(held(), ["data-hold"]);
  fire("onMouseLeave", {});
  assert.deepEqual(held(), []);
  fire("onClick", {});
  fire("onMouseEnter", {});
  assert.deepEqual(held(), []);
  fire("onClick", {});
  fire("onFocusIn", {});
  assert.deepEqual(held(), []);
  const blurred: string[] = [];
  fire("onKeyDown", {
    key: "Escape",
    target: { blur: () => blurred.push("blur") },
  });
  assert.deepEqual([held(), blurred], [["data-hold"], ["blur"]]);
  const opener = found(more["children"], "button").find(
    (node) => node["class"] === "run-more-open",
  );
  const click = opener?.["onClick"];
  assert.ok(typeof click === "function");
  const stopped: string[] = [];
  Reflect.apply(click, undefined, [
    { stopPropagation: () => stopped.push("stop") },
  ]);
  assert.deepEqual(stopped, ["stop"]);
});

await test("CLV-357 the ⋯ menu is a popover that opens on hover and on keyboard focus with a short close delay, in the page font, and does not move the page", () => {
  assert.match(rule(".run-more"), /position: relative/);
  const menu = rule(".run-more-menu");
  assert.match(menu, /position: absolute/);
  assert.match(menu, /visibility: hidden/);
  assert.match(menu, /font: [^;]*var\(--font-ui\)/);
  assert.match(menu, /transition: [^;]*visibility 0s linear 200ms/);
  const shown = rule(
    ".run-more:hover .run-more-menu, .run-more:focus-within .run-more-menu",
  );
  assert.match(shown, /visibility: visible/);
  assert.match(shown, /transition-delay: 0s/);
  assert.match(rule(".run-head-actions button"), /font: [^;]*var\(--font-ui\)/);
  const hold = rule(".run-more[data-hold] .run-more-menu");
  assert.match(hold, /visibility: hidden/);
  assert.match(hold, /transition: none/);
  assert.ok(
    rules.indexOf("\n.run-more[data-hold] .run-more-menu {") >
      rules.indexOf(
        "\n.run-more:hover .run-more-menu, .run-more:focus-within .run-more-menu {",
      ),
  );
  assert.match(
    rule(".run-identity:hover .name-edit, .name-edit:focus"),
    /opacity: 1/,
  );
});

await test("CLV-357 the README describes the banner, the facts line and the tabs of the run detail", async () => {
  const readme = (
    await readFile(new URL("../README.md", import.meta.url), "utf8")
  ).replaceAll("\n", " ");
  for (const part of [
    /The banner also shows the label and the title of the run, with a pencil that edits both in place: Enter saves and Escape cancels\./,
    /One action bar holds \*\*Steer\*\*, \*\*Pause\*\* or \*\*Resume\*\*, and a `⋯` menu with \*\*Rename\*\* and \*\*Drop\*\*\. The menu opens when the pointer rests on `⋯` or when `⋯` has the keyboard focus\./,
    /Under the banner, one line shows the pull request with its latest review score, the cost and the place of the run in its chain\. A fact that is not known does not show\./,
    /\*\*Details\*\* shows the run totals, the reason code and text, the run ID, the turn target, the workflow, the effect units, the chain and the sources of the label and the title\./,
  ])
    assert.match(readme, part);
});
