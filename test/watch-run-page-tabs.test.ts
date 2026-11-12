import assert from "node:assert/strict";
import { test } from "node:test";
import { component } from "../src/cli/watch-element.ts";
import { Page } from "../src/cli/watch-view.ts";
import { rendered } from "./watch-dom.ts";
import {
  at,
  noCopy,
  sampleModel,
  sampleTurn,
  wantedTranscripts,
} from "./watch-sample.ts";
import { quiet, working, bare, page } from "./watch-run-page-fixture.ts";

await test("CLV-357 the run page has four tabs, Details holds the totals, the reason, the IDs, the effect units and the chain, and the page has no queue details and no footer line", () => {
  const html = rendered(page(working));
  assert.deepEqual(
    [...html.matchAll(/<button[^>]*role="tab"[^>]*>([^<]*)<\/button>/g)].map(
      (match) => match[1],
    ),
    ["Transcript", "Pull request", "Events (2)", "Details"],
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
  assert.doesNotMatch(html, /lanes busy|line-queue/);
  const none = rendered(page(bare));
  assert.match(
    none.slice(none.indexOf('id="run-panel-transcript"')),
    /^id="run-panel-transcript"[^>]*><p class="meta">No agent turn for this run\.<\/p>/,
  );
});

await test("CLV-357 the Events tab shows the event rows at once, with no closed details wrapper and no All events toggle", () => {
  const html = rendered(page(working));
  const events = html.slice(
    html.indexOf('id="run-panel-events"'),
    html.indexOf('id="run-panel-details"'),
  );
  assert.doesNotMatch(events, /<details|<summary|All events/);
  assert.match(
    events,
    /<section class="events code-window"><div class="event">[^<]* run\.created<\/div>/,
  );
  assert.match(html, /role="tab"[^>]*>Events \(2\)<\/button>/);
});

await test("CLV-357 Details shows one block for each turn with its state, time, cost, branch, work tree, harness, known tokens and attempts, and hides what is not known", () => {
  const ended = sampleTurn({
    key: "k2",
    operationId: "operation-2",
    outcome: "completed",
    endedAt: at("21:33:40"),
    costUsd: 1.5,
    harness: "claude",
    usage: {
      input_tokens: 86,
      cache_read_input_tokens: 5212538,
      cache_creation_input_tokens: 142425,
      output_tokens: 38984,
    },
    attempts: [
      {
        attempt: 1,
        model: "claude-opus-5-5",
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 20,
          output_tokens: 30,
        },
        costUsd: 0.5,
        estimatedCostUsd: null,
      },
    ],
  });
  const run = { ...working, runId: "run-10", turns: [sampleTurn(), ended] };
  const shown = rendered(
    component(Page, {
      model: sampleModel([run]),
      selected: "run=run-10",
      now: at("21:34:41"),
      stale: false,
      copying: noCopy,
    }),
  );
  const details = shown.slice(shown.indexOf('id="run-panel-details"'));
  const blocks = [
    ...details.matchAll(/<section class="turn-facts">(.*?)<\/section>/g),
  ].map((match) => match[1] ?? "");
  assert.equal(blocks.length, 2);
  assert.match(
    blocks[0] ?? "",
    /^<h4>Turn 1 · in work · 8 min 39 s<\/h4><dl class="run-details"><dt>Branch<\/dt><dd>cloving\/clv-016-a6f7ef47<\/dd><dt>Work tree<\/dt><dd>clv-016-a6f7ef47<\/dd><\/dl>$/,
  );
  assert.match(
    blocks[1] ?? "",
    /^<h4>Turn 2 · completed · 7 min 38 s · 1\.50 USD<\/h4><dl class="run-details">.*<dt>Harness<\/dt><dd>claude<\/dd><dt>Tokens<\/dt><dd>86 input · 5212538 cache read · 142425 cache write · 38984 output<\/dd><\/dl><p class="turn-attempt">Attempt 1/,
  );
  assert.doesNotMatch(blocks.join(""), /not known/);
  assert.doesNotMatch(
    shown,
    /run-tab-turn|run-panel-turn|turn code-window|class="tools"/,
  );
});

await test("CLV-357 a stored or linked tab value that the page no longer has selects Transcript", () => {
  const shown = rendered(
    component(Page, {
      model: sampleModel([working]),
      selected: "run=run-7",
      now: at("21:34:41"),
      stale: false,
      copying: noCopy,
      transcripts: { ...wantedTranscripts, tab: "turn" },
    }),
  );
  assert.match(shown, /id="run-tab-transcript" aria-selected="true"/);
  assert.match(
    shown,
    /id="run-panel-transcript" aria-labelledby="run-tab-transcript">/,
  );
});
