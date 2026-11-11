import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { found, rendered } from "./watch-dom.ts";
import { renameControls, type RenameCalls } from "./watch-rename-fixture.ts";
import { rule, rules } from "./watch-style-fixture.ts";
import {
  working,
  bare,
  ended,
  page,
  commands,
  steers,
  all,
  banner,
  click,
} from "./watch-run-page-fixture.ts";

await test("CLV-357 the banner holds the back link, the state icon, the label and the title, and one action bar with Steer, Pause and a ⋯ menu that holds Rename and Drop", () => {
  const html = banner(rendered(page(working, all([]))));
  assert.match(
    html,
    /^<section class="banner working"><a class="banner-back" href="#">← Floor<\/a><span class="icon">●<\/span><div class="banner-main"><h2 class="run-identity"><span class="name-label">#726<\/span><span class="name-title">Find commit signatures<\/span><button type="button" class="name-edit" title="Rename" aria-label="Rename">✎<\/button><\/h2>/,
  );
  const bar = html.slice(html.indexOf('<div class="run-head-actions">'));
  assert.match(
    bar,
    /^<div class="run-head-actions"><button type="button" class="steer-open">Steer<\/button><button type="button" class="run-command-pause">Pause<\/button><div class="token-menu"><button type="button" class="token-menu-open" title="More run controls" aria-label="More run controls" popovertarget="run-menu-run-7" popovertargetaction="show">/,
  );
  const menu = bar.slice(bar.indexOf('<div id="run-menu-run-7"'));
  assert.match(
    menu,
    /^<div id="run-menu-run-7" class="token-pop" popover="auto"><div class="run-more-items"><button type="button" class="rename-open">Rename<\/button><hr class="token-separator">(?:<\/hr>)?<div class="token-danger"><button type="button" class="run-command-drop">Drop<\/button><\/div><\/div><\/div>/,
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

function popover(state: "open" | "closed") {
  const calls: string[] = [];
  return {
    calls,
    matches: (selector: string) =>
      selector === ":popover-open" && state === "open",
    hidePopover: () => calls.push("hide"),
  };
}

await test("CLV-357 the run page ⋯ uses the shared token menu shell, and a pick in its popover closes the popover at once", () => {
  const pop = found(page(working, all([])), "div").find(
    (node) => node["id"] === "run-menu-run-7",
  );
  const picked = pop?.["onClick"];
  assert.ok(typeof picked === "function");
  const open = popover("open");
  Reflect.apply(picked, undefined, [{ currentTarget: open }]);
  const closed = popover("closed");
  Reflect.apply(picked, undefined, [{ currentTarget: closed }]);
  assert.deepEqual([open.calls, closed.calls], [["hide"], []]);
  const floor = rendered(page(working, all([]))).replace(/run-menu-run-7/g, "");
  assert.doesNotMatch(floor, /run-more-open|run-more-menu|data-hold/);
});

await test("CLV-357 an ended run shows no Steer form, also when the form was open, and keeps the reply of the last note", () => {
  const html = rendered(
    page(ended, {
      steering: steers([], { open: "run-9", messages: { "run-9": "Sent." } }),
    }),
  );
  assert.doesNotMatch(html, /steer-form|steer-open/);
  assert.match(html, /<p class="steer-message" role="status">Sent\.<\/p>/);
});

await test("CLV-357 the ⋯ of the run page is a visible button in the action bar, its popover is the shared token popover, and the bar buttons use the page font", () => {
  const opener = rule(".run-head-actions .token-menu-open");
  assert.match(opener, /position: static/);
  assert.match(opener, /opacity: 1/);
  assert.match(
    rule(".run-head-actions > button, .run-head-actions .token-menu-open"),
    /font: [^;]*var\(--font-ui\)/,
  );
  assert.match(
    rule(".token-danger button"),
    /color: var\(--color-state-failed\)/,
  );
  assert.doesNotMatch(rules, /\.run-more-menu|data-hold/);
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
    /The menu is the same popover as the token menu of the floor\. A pick in it closes it at once\. It also closes a moment after the pointer leaves, or with Escape\./,
    /\*\*Events\*\* shows the command effects and the list of all events, open at once with no further click, with the count in the tab name\./,
    /Under the banner, one line shows the pull request with its latest review score, the cost and the place of the run in its chain\. A fact that is not known does not show\./,
    /\*\*Details\*\* shows the run totals, the reason code and text, the run ID, the turn target, the workflow, the effect units, the chain and the sources of the label and the title\. Under them, one block for each agent turn shows its state, its time, its cost, its branch, its work tree, its harness, its token counts and its attempts\. A value that is not known does not show\./,
  ])
    assert.match(readme, part);
});
