import assert from "node:assert/strict";
import { test } from "node:test";
import type { WatchRun } from "../src/cli/watch-render.ts";
import { pageTitle, renderPage } from "../src/cli/watch-view.ts";
import { phases, sampleModel, sampleRun, sampleTurn } from "./watch-sample.ts";

const waiting = sampleRun();
const done = sampleRun({
  runId: "run-2",
  workflowId: "develop-prompt",
  state: "completed",
  code: "run-completed",
  detail: "The run completed.",
  decisions: [],
  turns: [],
  events: [],
  phases: phases(["done", "done", "done", "done", "done"]),
});
const model = sampleModel([done, waiting]);

function positions(html: string, parts: readonly string[]): number[] {
  return parts.map((part) => {
    assert.ok(html.includes(part), `${part}\n${html}`);
    return html.indexOf(part);
  });
}

function banner(run: Partial<WatchRun>): string {
  const html = renderPage(sampleModel([sampleRun(run)]), "");
  const start = html.indexOf('<section class="banner');
  return html.slice(start, html.indexOf("</section>", start));
}

await test("CLV-016 the watch page shows the state of the selected run first, as a banner with a tone, an icon and plain words, then the steps of the run, its pending decision, its turn, its folded events and its identifiers", () => {
  const html = renderPage(model, "run-1");
  const found = positions(html, [
    '<nav><a class="run good" href="#run-2"><span class="icon">✓</span> run-2 · Completed</a><a class="run attention selected" href="#run-1"><span class="icon">!</span> clv-016-a6f7ef47 · Needs your decision</a></nav>',
    '<section class="banner attention"><span class="icon">!</span><div><h2>Needs your decision <span class="name">clv-016-a6f7ef47</span></h2><p>A decision waits for you for <span data-since="2026-10-13T21:33:41.000Z">1 min 0 s</span>. Examine the work, then approve or deny.</p></div></section>',
    '<ol class="phases"><li class="phase done"><span class="mark">✓</span><span class="name">Admitted</span><span class="time"><span data-clock="2026-10-13T21:26:00.000Z">21:26:00</span></span></li>',
    '<li class="phase done"><span class="mark">✓</span><span class="name">Claude turn</span><span class="time">7 min 38 s</span></li>',
    '<li class="phase active"><span class="mark">●</span><span class="name">Your review</span><span class="time"><span data-since="2026-10-13T21:33:41.000Z">1 min 0 s</span></span></li>',
    '<li class="phase pending"><span class="mark">○</span><span class="name">Completed</span><span class="time"></span></li></ol>',
    '<section class="decision">',
    '<section class="turn">',
    '<details class="events" data-key="events"><summary>All events (2)</summary>',
    '<p class="meta foot">develop-ticket · run-1 · 1 of 8 effect units<br>policy-approval: A person must approve.</p>',
  ]);
  assert.deepEqual(
    found,
    found.toSorted((first, second) => first - second),
  );
});

await test("CLV-016 the banner of a run in work shows the time of the turn, the count of the tool calls, the time of the last output and the last activity", () => {
  const working = {
    state: "running",
    code: "run-running",
    detail: "The run is in work.",
    decisions: [],
    phases: phases(["done", "done", "active"]),
  };
  const activity = [
    { kind: "tool", text: "Bash: node tools/check-quality.ts" },
    { kind: "say", text: "I run the gate <now>." },
  ];
  assert.equal(
    banner({ ...working, turns: [sampleTurn({ activity })] }),
    '<section class="banner working"><span class="icon">●</span><div><h2>In work <span class="name">clv-016-a6f7ef47</span></h2><p>Claude works for <span data-since="2026-10-13T21:26:02.000Z">8 min 39 s</span> · 1 tool call · last output <span data-since="2026-10-13T21:30:20.000Z">4 min 21 s</span> ago<span class="now">I run the gate &lt;now&gt;.</span></p></div>',
  );
  assert.match(
    banner({ ...working, turns: [sampleTurn({ activeAt: null })] }),
    /<\/span> · 0 tool calls<span class="now">The worker starts\.<\/span><\/p>/,
  );
  assert.match(
    banner({ ...working, turns: [] }),
    /<h2>In work <span class="name">run-1<\/span><\/h2><p>run-running: The run is in work\.<\/p>/,
  );
});

await test("CLV-016 the banner of a run at its end shows the time and the cost of a completed run, and the reason of a run that failed, that was dropped or that is in a different state", () => {
  const ended = { decisions: [], state: "completed" };
  assert.match(
    banner(ended),
    /^<section class="banner good"><span class="icon">✓<\/span><div><h2>Completed .*<p>The run completed in 7 min 41 s · cost 1\.03 USD\.<\/p>/,
  );
  assert.match(
    banner({ ...ended, events: [], turns: [] }),
    /<p>The run completed · cost 0\.00 USD\.<\/p>/,
  );
  assert.match(
    banner({ ...ended, decision: "approved" }),
    /^<section class="banner good">.*<h2>Completed .*<p>You approved the work\. The run completed in 7 min 41 s · cost 1\.03 USD\.<\/p>/,
  );
  assert.match(
    banner({ ...ended, decision: "denied" }),
    /^<section class="banner idle"><span class="icon">✕<\/span><div><h2>Denied .*<p>You denied the work\. The run completed in 7 min 41 s · cost 1\.03 USD\.<\/p>/,
  );
  const reason = { code: "world-run-failed", detail: "It failed & stopped." };
  for (const [state, shown] of [
    ["failed", 'banner bad"><span class="icon">✕</span><div><h2>Failed '],
    ["cancelled", 'banner bad"><span class="icon">✕</span><div><h2>Dropped '],
    ["paused", 'banner attention"><span class="icon">Ⅱ</span><div><h2>Paused '],
    ["<new>", 'banner idle"><span class="icon">○</span><div><h2>&lt;new&gt; '],
  ] as const) {
    const html = banner({ ...ended, ...reason, state });
    assert.ok(html.includes(shown), html);
    assert.ok(
      html.includes("<p>world-run-failed: It failed &amp; stopped.</p>"),
      html,
    );
  }
});

await test("CLV-016 the steps of a run that failed show the step that stopped and the end with its clock time", () => {
  const html = renderPage(
    sampleModel([
      sampleRun({
        state: "failed",
        phases: phases(
          ["done", "done", "failed", "pending", "failed"],
          "Failed",
        ),
      }),
    ]),
    "",
  );
  positions(html, [
    '<li class="phase failed"><span class="mark">✕</span><span class="name">Claude turn</span><span class="time"></span></li>',
    '<li class="phase failed"><span class="mark">✕</span><span class="name">Failed</span><span class="time"><span data-clock="2026-10-13T21:35:01.000Z">21:35:01</span></span></li></ol>',
  ]);
});

await test("CLV-016 the watch page shows the newest run when no run is selected, and plain words for no turn, for no run and for a service that does not answer", () => {
  const newest = renderPage(model, "");
  positions(newest, [
    '<a class="run good selected" href="#run-2">',
    "No Claude turn for this run.",
    '<p class="meta foot">develop-prompt · run-2 · 1 of 8 effect units<br>',
  ]);
  const bare = renderPage(
    sampleModel([sampleRun({ spent: null, limit: null })]),
    "",
  );
  positions(bare, ['<p class="meta foot">develop-ticket · run-1<br>']);
  const empty = renderPage({ ...model, service: "down", runs: [] }, "");
  positions(empty, [
    '<p class="down">The Cloving service does not answer. The page shows the last known records.</p>',
    "No run yet. Submit one with <code>cloving run</code>.",
  ]);
});

await test("CLV-016 the title of the watch page shows the state of the selected run and the count of the runs that wait for a decision", () => {
  assert.deepEqual(
    [
      pageTitle(model, "run-1"),
      pageTitle(model, ""),
      pageTitle(sampleModel([done]), "run-9"),
      pageTitle(sampleModel([{ ...done, decision: "denied" }]), ""),
      pageTitle(sampleModel([]), ""),
    ],
    [
      "(1) ! Needs your decision · clv-016-a6f7ef47 · Cloving",
      "(1) ✓ Completed · run-2 · Cloving",
      "✓ Completed · run-2 · Cloving",
      "✕ Denied · run-2 · Cloving",
      "Cloving",
    ],
  );
  const chips = renderPage(sampleModel([{ ...done, decision: "denied" }]), "");
  assert.ok(
    chips.includes(
      '<a class="run idle selected" href="#run-2"><span class="icon">✕</span> run-2 · Denied</a>',
    ),
    chips,
  );
});
