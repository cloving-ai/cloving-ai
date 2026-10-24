import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { component } from "../src/cli/watch-element.ts";
import type { WatchModel, WatchRun } from "../src/cli/watch-render.ts";
import { Header, Page } from "../src/cli/watch-view.ts";
import { found, rendered } from "./watch-dom.ts";
import {
  at,
  noCopy,
  phases,
  sampleModel,
  sampleRun,
  sampleTurn,
  shownClock,
} from "./watch-sample.ts";

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

function page(
  shown: WatchModel | null,
  selected = shown?.runs[0]?.runId ?? "",
): string {
  return rendered(
    component(Page, {
      model: shown,
      selected,
      now: at("21:34:41"),
      stale: false,
      copying: noCopy,
    }),
  );
}

function positions(html: string, parts: readonly string[]): number[] {
  return parts.map((part) => {
    assert.ok(html.includes(part), `${part}\n${html}`);
    return html.indexOf(part);
  });
}

function banner(run: Partial<WatchRun>): string {
  const html = page(sampleModel([sampleRun(run)]));
  const start = html.indexOf('<section class="banner');
  return html.slice(start, html.indexOf("</section>", start));
}

await test("CLV-016 the watch page shows the state of the selected run first, as a banner with a tone, an icon and plain words, then the steps of the run, its pending decision, its turn, its folded events and its identifiers", () => {
  const found = positions(page(model, "run-1"), [
    `<span>updated ${shownClock("21:34:41")}</span></header>`,
    '<a class="back" href="#workflow=develop-ticket">← Back to develop-ticket</a>',
    '<section class="banner attention"><span class="icon">!</span><div><h2>Needs your decision <span class="name">clv-016-a6f7ef47</span></h2><p>A decision waits for you for 1 min 0 s. Examine the work, then approve or deny.</p></div></section>',
    `<ol class="phases"><li class="phase done"><span class="mark">✓</span><span class="name">Admitted</span><span class="time">${shownClock("21:26:00")}</span></li>`,
    '<li class="phase done"><span class="mark">✓</span><span class="name">Agent turn</span><span class="time">7 min 38 s</span></li>',
    '<li class="phase active"><span class="mark">●</span><span class="name">Your review</span><span class="time">1 min 0 s</span></li>',
    '<li class="phase pending"><span class="mark">○</span><span class="name">Completed</span><span class="time"></span></li></ol>',
    '<section class="decision">',
    '<section class="turn code-window">',
    '<details class="events code-window"><summary class="code-head">All events (2)</summary>',
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
    '<section class="banner working"><span class="icon">●</span><div><h2>In work <span class="name">clv-016-a6f7ef47</span></h2><p>Claude works for 8 min 39 s · 1 tool call · last output 4 min 21 s ago<span class="now">I run the gate &lt;now&gt;.</span></p></div>',
  );
  assert.match(
    banner({ ...working, turns: [sampleTurn({ activeAt: null })] }),
    /<p>Claude works for 8 min 39 s · 0 tool calls<span class="now">The worker starts\.<\/span><\/p>/,
  );
  assert.match(
    banner({ ...working, turns: [] }),
    /<h2>In work <span class="name">run-1<\/span><\/h2><p>run-running: The run is in work\.<\/p>/,
  );
});

await test("CLV-016 the banner of a run at its end shows the time and the cost of a completed run with the decision of the operator, and the reason of a run that failed, that was dropped or that is in a different state", () => {
  const ended = { decisions: [], state: "completed" };
  assert.match(
    banner(ended),
    /^<section class="banner good"><span class="icon">✓<\/span><div><h2>Completed .*<p>The run completed in 7 min 41 s · cost 1\.03 USD\.<\/p>/,
  );
  assert.match(
    banner({ ...ended, events: [], turns: [], claudeCostUsd: null }),
    /<p>The run completed · cost Price not known\.<\/p>/,
  );
  assert.match(
    banner({ ...ended, decision: "approved" }),
    /^<section class="banner good">.*<p>You approved the work\. The run completed in 7 min 41 s · cost 1\.03 USD\.<\/p>/,
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
    positions(html, [
      shown,
      "<p>world-run-failed: It failed &amp; stopped.</p>",
    ]);
  }
});

await test("CLV-016 the steps of a run that failed show the step that stopped and the end with its clock time, and the banner shows a run that the operator denied", () => {
  const failed = sampleRun({
    state: "failed",
    phases: phases(["done", "done", "failed", "pending", "failed"], "Failed"),
  });
  positions(page(sampleModel([failed])), [
    '<li class="phase failed"><span class="mark">✕</span><span class="name">Agent turn</span><span class="time"></span></li>',
    `<li class="phase failed"><span class="mark">✕</span><span class="name">Failed</span><span class="time">${shownClock("21:35:01")}</span></li></ol>`,
  ]);
  positions(page(sampleModel([{ ...done, decision: "denied" }])), [
    '<section class="banner idle"><span class="icon">✕</span><div><h2>Denied',
  ]);
});

await test("CLV-016 the full page shows a selected run and plain words for no turn, for no workflows, for no data and for a service that does not answer", () => {
  positions(page(model), [
    '<a class="back" href="#workflow=develop-prompt">← Back to develop-prompt</a>',
    '<p class="meta">No agent turn for this run.</p>',
    '<p class="meta foot">develop-prompt · run-2 · 1 of 8 effect units<br>',
  ]);
  positions(page(sampleModel([sampleRun({ spent: null, limit: null })])), [
    '<p class="meta foot">develop-ticket · run-1<br>',
  ]);
  positions(page({ ...model, service: "down", runs: [] }), [
    '<p class="down">The Cloving service does not answer. The page shows the last known records.</p>',
    '<p class="meta">No workflows registered.</p>',
  ]);
  assert.equal(
    page(null).slice(page(null).indexOf("<span>")),
    '<span></span></header><p class="meta">The page waits for the first data of the watch tool.</p>',
  );
});

await test("CLV-016 the watch page says that the watch tool does not answer, and it keeps the last data", () => {
  const props = { selected: "run-2", now: at("21:34:41"), copying: noCopy };
  const stale = rendered(component(Page, { ...props, model, stale: true }));
  positions(stale, [
    '<span class="bad">The watch tool does not answer.</span></header>',
    '<a class="back" href="#workflow=develop-prompt">← Back to develop-prompt</a>',
  ]);
});

await test("CLV-062 the watch page shows each turn and each review of a run in order, with the feedback of each denial", () => {
  const html = page(
    sampleModel([
      sampleRun({
        turns: [
          { ...sampleTurn(), key: "turn-1" },
          { ...sampleTurn(), key: "turn-2" },
        ],
        decisions: [
          {
            decisionId: "run-1/review-2",
            type: "approval",
            prompt: "Review round 2.",
            approve: "cloving approve run-1/review-2",
            deny: 'cloving deny run-1/review-2 --text "<feedback>"',
          },
        ],
        feedback: [
          {
            decisionId: "run-1/review-1",
            text: "Add a test for <empty> lists.",
          },
        ],
      }),
    ]),
    "run-1",
  );
  const turn = '<section class="turn code-window">';
  const first =
    '<section class="review denied"><h3>Review 1 · denied</h3><p>Add a test for &lt;empty&gt; lists.</p></section>';
  const second =
    '<section class="review pending"><h3>Review 2 · waits for your decision</h3></section>';
  const found = [
    html.indexOf('<section class="decision">'),
    html.indexOf(turn),
    html.indexOf(first),
    html.lastIndexOf(turn),
    html.indexOf(second),
  ];
  assert.ok(
    found.every((index) => index >= 0),
    html,
  );
  assert.deepEqual(
    found,
    found.toSorted((left, right) => left - right),
  );
  assert.notEqual(found[1], found[3]);
  assert.match(
    html,
    /<code>cloving deny run-1\/review-2 --text &quot;&lt;feedback&gt;&quot;<\/code>/,
  );
});

await test("CLV-065 the watch page shows the pull request of a develop-issue run as a link, the Greptile score of each review and the merge commit, after the steps", () => {
  const url = "https://github.com/cloving-ai/cloving-ai/pull/61";
  const merged = "c0ffee1234567890c0ffee1234567890c0ffee12";
  const issue = sampleRun({
    workflowId: "develop-issue",
    state: "completed",
    decisions: [],
    pullRequest: { number: 61, url },
    reviews: [
      { round: 1, commit: "aaaaaaa1111111", score: 4 },
      { round: 2, commit: "bbbbbbb2222222", score: 5 },
    ],
  });
  const section = (run: WatchRun): string => {
    const html = page(sampleModel([run]));
    const start = html.indexOf('<section class="pull">');
    return start < 0
      ? ""
      : html.slice(start, html.indexOf("</section>", start));
  };
  const reviews =
    '<ul class="reviews"><li>Round 1 · Greptile 4/5 · commit aaaaaaa</li><li>Round 2 · Greptile 5/5 · commit bbbbbbb</li></ul>';
  assert.equal(
    section(issue),
    `<section class="pull"><h3>Pull request <a href="${url}">#61</a></h3>${reviews}`,
  );
  assert.equal(
    section({ ...issue, mergeCommit: merged }),
    `<section class="pull"><h3>Pull request <a href="${url}">#61</a></h3>${reviews}<p class="meta">Merge commit <code>${merged}</code></p>`,
  );
  positions(page(sampleModel([issue])), [
    '<ol class="phases">',
    '<section class="pull">',
    '<section class="turn code-window">',
  ]);
  assert.equal(section(sampleRun()), "");
});

await test("CLV-098 the brand names cloving beside the hidden accent clove SVG", () => {
  const shown = component(Header, { model: null, stale: false });
  const [brand] = found(shown, "strong");
  assert.ok(brand);
  assert.equal(brand["class"], "brand");
  const [svg] = found(shown, "svg");
  assert.ok(svg);
  assert.equal(svg["aria-hidden"], "true");
  assert.equal(svg["focusable"], "false");
  assert.equal(
    svg["viewBox"],
    "0.6625858545303345 0.6630800366401672 46.674827575683594 46.673831939697266",
  );
  const paths = found(shown, "path");
  assert.equal(paths.length, 4);
  assert.ok(paths.every((path) => path["fill"] === "currentColor"));
  assert.equal(
    createHash("sha256")
      .update(JSON.stringify(paths.map((path) => path["d"])))
      .digest("hex"),
    "85c874e4c8e439c77b2ef2ec65144df31fec3e83e4ed61cb02010ec4e33fbbbe",
  );
  assert.match(rendered(shown), /<\/svg>cloving<\/strong>/);
});
