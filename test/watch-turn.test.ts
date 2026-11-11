import assert from "node:assert/strict";
import { test } from "node:test";
import { component } from "../src/cli/watch-element.ts";
import { Decision } from "../src/cli/watch-decision-view.ts";
import { Events } from "../src/cli/watch-turn.ts";
import { TurnFacts } from "../src/cli/watch-run-tabs-view.ts";
import { found, rendered } from "./watch-dom.ts";
import {
  at,
  noCopy,
  reviewedTurn,
  sampleDecision,
  sampleTurn,
  shownClock,
} from "./watch-sample.ts";

function includes(html: string, parts: readonly string[]): void {
  for (const part of parts) assert.ok(html.includes(part), `${part}\n${html}`);
}

await test("CLV-016 the watch page shows a pending decision with the commits, the changed files and the report of the worker, with the full text open and one command for each answer", () => {
  const html = rendered(
    component(Decision, {
      decision: sampleDecision,
      turn: reviewedTurn,
      copying: noCopy,
      now: at("21:26:44"),
    }),
  );
  assert.equal(
    html,
    [
      '<section class="decision" id="decision-run-1/review-1"><h3>Your decision · approval</h3>',
      '<pre class="request">Review &lt;b&gt;this&lt;/b&gt; &amp; that.</pre>',
      '<div class="command code-window"><span class="label code-head">Approve</span><code>cloving approve run-1/review-1 --text &quot;yes&quot;</code><button type="button">Copy</button></div>',
      '<div class="command code-window"><span class="label code-head">Deny</span><code>cloving deny run-1/review-1</code><button type="button">Copy</button></div>',
      '<p class="fact">Branch <code>cloving/clv-016-a6f7ef47</code> · 1 commit</p>',
      "<pre>9e69feb Reject a &lt;request&gt;</pre>",
      "<pre> src/a.ts | 6 ++++++\n 1 file changed, 6 insertions(+)</pre>",
      '<p class="good">All the work is committed.</p>',
      '<details open><summary>Report of the worker</summary><div class="report">I added the check &amp; one test.</div></details>',
      "</section>",
    ].join(""),
  );
});

await test("CLV-016 the watch page warns about work that is not committed and about a turn with no commit, and it shows a decision with no turn with its full text open", () => {
  const shown = (turn: Parameters<typeof sampleTurn>[0]): string =>
    rendered(
      component(Decision, {
        decision: sampleDecision,
        turn: turn === undefined ? undefined : sampleTurn(turn),
        copying: noCopy,
        now: at("21:26:44"),
      }),
    );
  includes(shown({ ...reviewedTurn, commits: [], uncommitted: [" M a.ts"] }), [
    '<p class="bad">The worker made no commit.</p>',
    '<p class="bad">1 file is not committed:</p><pre> M a.ts</pre>',
  ]);
  includes(shown({ ...reviewedTurn, uncommitted: [" M a.ts", "?? b.ts"] }), [
    '<p class="bad">2 files are not committed:</p>',
  ]);
  const alone = shown(undefined);
  includes(alone, [
    '<pre class="request">Review &lt;b&gt;this&lt;/b&gt; &amp; that.</pre>',
  ]);
  assert.equal(alone.includes("Report of the worker"), false);
});

await test("CLV-016 a click on the copy control of a command gives that command to the page, and the control shows the result for that command only", () => {
  const copied: string[] = [];
  const copying = {
    command: sampleDecision.deny,
    label: "Copied",
    onCopy: (command: string): void => {
      copied.push(command);
    },
  };
  const [approve, deny] = found(
    component(Decision, {
      decision: sampleDecision,
      turn: undefined,
      copying,
      now: at("21:26:44"),
    }),
    "button",
  );
  const click: unknown = approve?.["onClick"];
  assert.ok(typeof click === "function");
  Reflect.apply(click, undefined, []);
  assert.deepEqual(copied, [sampleDecision.approve]);
  assert.deepEqual(
    [approve?.["children"], deny?.["children"]],
    ["Copy", "Copied"],
  );
});

await test("CLV-016 CLV-357 the watch page lists the events of a run open, with no toggle, and says when a run has no event", () => {
  const events = [
    { sequence: 1, recordedAt: at("21:26:00"), type: "run.<created>" },
  ];
  assert.equal(
    rendered(component(Events, { events })),
    `<section class="events code-window"><div class="event">${shownClock("21:26:00")} run.&lt;created&gt;</div></section>`,
  );
  assert.equal(
    rendered(component(Events, { events: [] })),
    '<p class="meta">No events for this run.</p>',
  );
});

await test("CLV-098 event and command code windows keep their headings and copy controls, and the event list has no disclosure", () => {
  assert.doesNotMatch(
    rendered(component(Events, { events: [] })),
    /<details|<summary/,
  );
  const decision = rendered(
    component(Decision, {
      decision: sampleDecision,
      turn: undefined,
      copying: noCopy,
      now: at("21:26:44"),
    }),
  );
  assert.match(
    decision,
    /<div class="command code-window"><span class="label code-head">Approve<\/span><code>/,
  );
  assert.match(decision, /<button type="button">Copy<\/button>/);
  assert.match(decision, /<pre class="request">/);
});

await test("CLV-094 CLV-357 the turn block of Details keeps zero prices and zero token counts and hides unknown prices and counts", () => {
  for (const [costUsd, price] of [
    [null, null],
    [-1, null],
    [Infinity, null],
    [0, "0.00 USD"],
    [0.25, "0.25 USD"],
  ] as const) {
    const turn = sampleTurn({
      costUsd,
      usage: {
        input_tokens: 0,
        cache_read_input_tokens: null,
        output_tokens: 2,
      },
    });
    const html = rendered(
      component(TurnFacts, { turn, position: 1, now: at("21:40:00") }),
    );
    assert.match(html, /<dt>Tokens<\/dt><dd>0 input · 2 output<\/dd>/);
    assert.doesNotMatch(html, /not known/);
    assert.equal(
      html.includes(price ?? "USD"),
      price !== null,
      String(costUsd),
    );
  }
});
