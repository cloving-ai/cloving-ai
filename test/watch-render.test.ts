import assert from "node:assert/strict";
import { test } from "node:test";
import { pageDocument } from "../src/cli/watch-page.ts";
import { renderPage, type WatchModel } from "../src/cli/watch-render.ts";

const model: WatchModel = {
  updatedAt: "2026-10-13T21:40:00.000Z",
  host: "/host",
  service: "up",
  runs: [
    {
      runId: "run-2",
      workflowId: "develop-prompt",
      state: "completed",
      code: "run-completed",
      detail: "The run completed.",
      spent: 1,
      limit: 8,
      decisions: [],
      events: [],
      turns: [],
    },
    {
      runId: "run-1",
      workflowId: "develop-ticket",
      state: "waiting_gate",
      code: "policy-approval",
      detail: "A person must approve.",
      spent: 1,
      limit: 8,
      decisions: [
        {
          decisionId: "run-1/review-1",
          type: "approval",
          prompt: "Review <b>this</b> & that.",
          approve: "cloving approve run-1/review-1",
          deny: "cloving deny run-1/review-1",
        },
      ],
      events: [
        {
          sequence: 1,
          recordedAt: "2026-10-13T21:26:00.123Z",
          type: "run.created",
        },
      ],
      turns: [
        {
          key: "k1",
          runId: "run-1",
          target: "clv-016-a6f7ef47",
          branch: "cloving/clv-016-a6f7ef47",
          worktree: "/host/worktrees/clv-016-a6f7ef47",
          startedAt: "2026-10-13T21:26:01.000Z",
          outcome: "in work",
          costUsd: 1.0330776000000002,
          activity: [
            { kind: "say", text: "I read <script>alert(1)</script>." },
            { kind: "tool", text: "Bash: git status" },
          ],
        },
      ],
    },
  ],
};

await test("CLV-016 the watch page shows the selected run with its state, its events, the activity of its turn and its pending decision, and it escapes each text", () => {
  const html = renderPage(model, "run-1");
  for (const part of [
    '<a class="run selected" href="#run-1">',
    '<a class="run" href="#run-2">',
    "waiting_gate",
    "policy-approval",
    "A person must approve.",
    "1 of 8 effect units",
    "21:26:00 run.created",
    "cloving/clv-016-a6f7ef47",
    "in work",
    "Claude turn · in work · 1.03 USD",
    '<div class="item say">I read &lt;script&gt;alert(1)&lt;/script&gt;.</div>',
    '<div class="item tool">Bash: git status</div>',
    "Review &lt;b&gt;this&lt;/b&gt; &amp; that.",
    "cloving approve run-1/review-1",
    "cloving deny run-1/review-1",
  ])
    assert.ok(html.includes(part), part);
  assert.equal(html.includes("<script>"), false);
});

await test("CLV-016 the watch page shows the newest run when no run is selected, and plain words for no run and for a service that does not answer", () => {
  const newest = renderPage(model, "");
  assert.ok(newest.includes('<a class="run selected" href="#run-2">'));
  assert.ok(newest.includes("The run completed."));
  assert.ok(newest.includes("No Claude turn for this run."));
  const empty = renderPage({ ...model, service: "down", runs: [] }, "");
  assert.ok(empty.includes("The Cloving service does not answer."));
  assert.ok(empty.includes("No run yet."));
});

await test("CLV-016 the watch page document has the render functions and a loader that reads the data of the watch server each second, with no outside resource", () => {
  const page = pageDocument();
  assert.match(page, /^<!doctype html>/);
  for (const part of [
    "function renderPage(",
    "function escapeHtml(",
    "function clovingUpdate(",
    'fetch("data.json", { cache: "no-store" })',
    "setInterval(load, 1000)",
  ])
    assert.ok(page.includes(part), part);
  assert.equal(/https?:\/\//.test(page), false);
});
