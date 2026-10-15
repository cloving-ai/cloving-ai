import assert from "node:assert/strict";
import { test } from "node:test";
import { component } from "../src/cli/watch-element.ts";
import type { WatchItem } from "../src/cli/watch-render.ts";
import { Decision, Events, Turn } from "../src/cli/watch-turn.ts";
import { found, rendered } from "./watch-dom.ts";
import {
  at,
  noCopy,
  reviewedTurn,
  sampleDecision,
  sampleTurn,
  shownClock,
} from "./watch-sample.ts";

const item = (kind: string, text: string): WatchItem => ({ kind, text });
const activity = [
  item("say", "I read <script>alert(1)</script>."),
  item("tool", "Bash: git status"),
  item("tool", "Read: /a/b.ts"),
  item("error", "exit code 1"),
  item("tool", "Bash: npm test"),
  item("say", "The test fails as expected."),
  item("tool", "Edit: /a/b.ts"),
  item("result", "Done. (cost 1.03 USD)"),
  item("tool", "Bash: sleep 1"),
  item("tool", "Bash: <wait>"),
];

function includes(html: string, parts: readonly string[]): void {
  for (const part of parts) assert.ok(html.includes(part), `${part}\n${html}`);
}

await test("CLV-016 the watch page folds the tool calls between two messages of the worker into one group with its counts, and it shows each message, each result and a single tool call as a line", () => {
  const turn = sampleTurn({ ...reviewedTurn, activity });
  const html = rendered(component(Turn, { turn, now: at("21:40:00") }));
  includes(html, [
    '<section class="turn"><h3>Claude turn · completed · 7 min 38 s · 1.03 USD</h3>',
    '<p class="meta">Branch cloving/clv-016-a6f7ef47 · work tree clv-016-a6f7ef47</p>',
    '<div class="activity"><div class="item say">I read &lt;script&gt;alert(1)&lt;/script&gt;.</div>',
    '<details class="tools"><summary>3 tool calls · <span class="bad">1 error</span><span class="last">Bash: npm test</span></summary><div class="item tool" title="Bash: git status">Bash: git status</div>',
    '<div class="item error">exit code 1</div>',
    '</details><div class="item say">The test fails as expected.</div><div class="item tool" title="Edit: /a/b.ts">Edit: /a/b.ts</div><div class="item result">Done. (cost 1.03 USD)</div>',
    '<details class="tools"><summary>2 tool calls<span class="last">Bash: &lt;wait&gt;</span></summary><div class="item tool" title="Bash: sleep 1">Bash: sleep 1</div><div class="item tool" title="Bash: &lt;wait&gt;">Bash: &lt;wait&gt;</div></details></div></section>',
  ]);
  assert.equal(html.includes("<script>"), false);
  assert.equal(html.includes(" open>"), false);
});

await test("CLV-016 the watch page keeps the last group of tool calls open while the turn is in work, with a time span to the present time, and it shows a turn that failed with no time", () => {
  const working = sampleTurn({ activity });
  const html = rendered(
    component(Turn, { turn: working, now: at("21:26:44") }),
  );
  includes(html, [
    "<h3>Claude turn · in work · 42 s</h3>",
    '<details class="tools"><summary>3 tool calls',
    '<details class="tools" open><summary>2 tool calls',
  ]);
  const failed = sampleTurn({ outcome: "failed" });
  includes(rendered(component(Turn, { turn: failed, now: at("21:26:44") })), [
    "<h3>Claude turn · failed</h3>",
    '<div class="activity"></div>',
  ]);
});

await test("CLV-016 the watch page shows a pending decision with the commits, the changed files and the report of the worker, with the full text folded and one command for each answer", () => {
  const html = rendered(
    component(Decision, {
      decision: sampleDecision,
      turn: reviewedTurn,
      copying: noCopy,
    }),
  );
  assert.equal(
    html,
    [
      '<section class="decision"><h3>Your decision · approval</h3>',
      '<p class="fact">Branch <code>cloving/clv-016-a6f7ef47</code> · 1 commit</p>',
      "<pre>9e69feb Reject a &lt;request&gt;</pre>",
      "<pre> src/a.ts | 6 ++++++\n 1 file changed, 6 insertions(+)</pre>",
      '<p class="good">All the work is committed.</p>',
      '<details open><summary>Report of the worker</summary><div class="report">I added the check &amp; one test.</div></details>',
      "<details><summary>Full text of the request</summary><pre>Review &lt;b&gt;this&lt;/b&gt; &amp; that.</pre></details>",
      '<div class="command"><span class="label">Approve</span><code>cloving approve run-1/review-1 --text &quot;yes&quot;</code><button type="button">Copy</button></div>',
      '<div class="command"><span class="label">Deny</span><code>cloving deny run-1/review-1</code><button type="button">Copy</button></div>',
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
    "<details open><summary>Full text of the request</summary>",
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
    component(Decision, { decision: sampleDecision, turn: undefined, copying }),
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

await test("CLV-016 the watch page folds the events of a run and shows their count", () => {
  const events = [
    { sequence: 1, recordedAt: at("21:26:00"), type: "run.<created>" },
  ];
  assert.equal(
    rendered(component(Events, { events })),
    `<details class="events"><summary>All events (1)</summary><div class="event">${shownClock("21:26:00")} run.&lt;created&gt;</div></details>`,
  );
});
