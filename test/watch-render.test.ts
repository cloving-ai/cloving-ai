import assert from "node:assert/strict";
import { test } from "node:test";
import {
  counted,
  elapsed,
  groupActivity,
  renderClock,
  renderDecision,
  renderEvents,
  renderSince,
  renderTurn,
  type WatchItem,
} from "../src/cli/watch-render.ts";
import {
  at,
  reviewedTurn,
  sampleDecision,
  sampleTurn,
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

await test("CLV-016 the watch page shows a time span in seconds, in minutes or in hours, a live span with its start time and a clock time with its full time", () => {
  assert.deepEqual(
    [
      elapsed(at("21:26:00"), at("21:26:42")),
      elapsed(at("21:26:00"), at("21:33:38")),
      elapsed(at("21:26:00"), at("22:30:59")),
      elapsed(at("21:26:00"), at("21:25:00")),
      elapsed("", at("21:25:00")),
    ],
    ["42 s", "7 min 38 s", "1 h 4 min", "0 s", ""],
  );
  assert.equal(
    renderSince(at("21:26:00"), at("21:26:42")),
    '<span data-since="2026-10-13T21:26:00.000Z">42 s</span>',
  );
  assert.equal(
    renderClock(at("21:26:00")),
    '<span data-clock="2026-10-13T21:26:00.000Z">21:26:00</span>',
  );
  assert.deepEqual(
    [counted(0, "commit"), counted(1, "commit"), counted(2, "commit")],
    ["0 commits", "1 commit", "2 commits"],
  );
});

await test("CLV-016 the watch page folds the tool calls between two messages of the worker into one group with its counts, and it shows each message, each result and a single tool call as a line", () => {
  assert.deepEqual(
    groupActivity(activity).map((group) => group.length),
    [1, 4, 1, 1, 1, 2],
  );
  assert.deepEqual(groupActivity([]), []);
  const html = renderTurn(
    sampleTurn({ ...reviewedTurn, activity }),
    at("21:40:00"),
  );
  includes(html, [
    "<h3>Claude turn · completed · 7 min 38 s · 1.03 USD</h3>",
    "Branch cloving/clv-016-a6f7ef47 · work tree /host/worktrees/clv-016-a6f7ef47",
    '<div class="item say">I read &lt;script&gt;alert(1)&lt;/script&gt;.</div>',
    '<details class="tools" data-key="k1:1"><summary>3 tool calls · <span class="bad">1 error</span><span class="last">Bash: npm test</span></summary>',
    '<div class="item error">exit code 1</div>',
    '</details><div class="item say">The test fails as expected.</div><div class="item tool" title="Edit: /a/b.ts">Edit: /a/b.ts</div><div class="item result">Done. (cost 1.03 USD)</div>',
    '<details class="tools" data-key="k1:5"><summary>2 tool calls<span class="last">Bash: &lt;wait&gt;</span></summary><div class="item tool" title="Bash: sleep 1">Bash: sleep 1</div><div class="item tool" title="Bash: &lt;wait&gt;">Bash: &lt;wait&gt;</div></details>',
  ]);
  assert.equal(html.includes("<script>"), false);
  assert.equal(html.includes(" open>"), false);
});

await test("CLV-016 the watch page keeps the last group of tool calls open while the turn is in work, with a live time span, and it shows a turn that failed with no time", () => {
  const working = renderTurn(sampleTurn({ activity }), at("21:26:44"));
  includes(working, [
    '<h3>Claude turn · in work · <span data-since="2026-10-13T21:26:02.000Z">42 s</span></h3>',
    '<details class="tools" data-key="k1:1"><summary>',
    '<details class="tools" data-key="k1:5" open><summary>',
  ]);
  const failed = renderTurn(sampleTurn({ outcome: "failed" }), at("21:26:44"));
  includes(failed, [
    "<h3>Claude turn · failed</h3>",
    '<div class="activity"></div>',
  ]);
});

await test("CLV-016 the watch page shows a pending decision with the commits, the changed files and the report of the worker, with the full text folded and a copy control for each command", () => {
  const html = renderDecision(sampleDecision, reviewedTurn);
  includes(html, [
    '<section class="decision">',
    "<h3>Your decision · approval</h3>",
    "Branch <code>cloving/clv-016-a6f7ef47</code> · 1 commit",
    "<pre>9e69feb Reject a &lt;request&gt;</pre>",
    "<pre> src/a.ts | 6 ++++++\n 1 file changed, 6 insertions(+)</pre>",
    '<p class="good">All the work is committed.</p>',
    '<details data-key="report" open><summary>Report of the worker</summary><div class="report">I added the check &amp; one test.</div></details>',
    '<details data-key="prompt"><summary>Full text of the request</summary><pre>Review &lt;b&gt;this&lt;/b&gt; &amp; that.</pre></details>',
    '<div class="command"><span class="label">Approve</span><code>cloving approve run-1/review-1 --text &quot;yes&quot;</code><button type="button" data-copy="cloving approve run-1/review-1 --text &quot;yes&quot;">Copy</button></div>',
    '<span class="label">Deny</span><code>cloving deny run-1/review-1</code>',
  ]);
});

await test("CLV-016 the watch page warns about work that is not committed and about a turn with no commit, and it shows a decision with no turn with its full text open", () => {
  const loose = renderDecision(
    sampleDecision,
    sampleTurn({ ...reviewedTurn, commits: [], uncommitted: [" M a.ts"] }),
  );
  includes(loose, [
    '<p class="bad">The worker made no commit.</p>',
    '<p class="bad">1 file is not committed:</p><pre> M a.ts</pre>',
  ]);
  const many = renderDecision(
    sampleDecision,
    sampleTurn({ ...reviewedTurn, uncommitted: [" M a.ts", "?? b.ts"] }),
  );
  includes(many, ['<p class="bad">2 files are not committed:</p>']);
  const alone = renderDecision(sampleDecision, undefined);
  includes(alone, [
    '<details data-key="prompt" open><summary>Full text of the request</summary>',
  ]);
  assert.equal(alone.includes("Report of the worker"), false);
});

await test("CLV-016 the watch page folds the events of a run and shows their count", () => {
  assert.equal(
    renderEvents([
      { sequence: 1, recordedAt: at("21:26:00"), type: "run.<created>" },
    ]),
    '<details class="events" data-key="events"><summary>All events (1)</summary><div class="event"><span data-clock="2026-10-13T21:26:00.000Z">21:26:00</span> run.&lt;created&gt;</div></details>',
  );
});
