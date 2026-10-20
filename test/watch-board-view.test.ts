import assert from "node:assert/strict";
import { test } from "node:test";
import { boardLayout } from "../src/cli/watch-board-view.ts";
import { component } from "../src/cli/watch-element.ts";
import type { WatchCard, WatchModel } from "../src/cli/watch-render.ts";
import { Page } from "../src/cli/watch-view.ts";
import {
  activeBoardModel,
  completionScenario,
  stagedModel,
} from "./watch-board-fixture.ts";
import { found, rendered } from "./watch-dom.ts";
import { noCopy } from "./watch-sample.ts";

function page(model: WatchModel, selected: string): string {
  return rendered(
    component(Page, {
      model,
      selected,
      now: model.updatedAt,
      stale: false,
      copying: noCopy,
      columns: {
        choices: { Done: false, Stopped: false },
        onToggle: () => undefined,
      },
    }),
  );
}

await test("CLV-140 column widths share the available space and overflow only below the minimum", () => {
  const wide = boardLayout({
    contentWidth: 1353,
    openColumns: 5,
    collapsedColumns: 2,
  });
  assert.equal(wide.columnWidth, 238.6);
  assert.equal(wide.totalWidth, 1353);
  const narrow = boardLayout({
    contentWidth: 1000,
    openColumns: 5,
    collapsedColumns: 2,
  });
  assert.equal(narrow.columnWidth, 200);
  assert.ok(narrow.totalWidth > 1000);
  assert.equal(narrow.totalWidth, 1160);
  assert.deepEqual(
    boardLayout({ contentWidth: 1000, openColumns: 0, collapsedColumns: 2 }),
    { columnWidth: 200, totalWidth: 100 },
  );
  assert.deepEqual(
    boardLayout({ contentWidth: 1000, openColumns: 0, collapsedColumns: 0 }),
    { columnWidth: 200, totalWidth: 0 },
  );
});

await test("CLV-140 workflow tabs sit above the board with names, counts and selection and no sidebar", () => {
  const html = page(activeBoardModel(), "workflow=develop-issue");
  assert.match(html, /<nav class="workflows" aria-label="Workflows">/);
  assert.match(html, /href="#workflow=develop-issue" aria-current="page"/);
  for (const [name, count] of [
    ["develop-issue", 7],
    ["develop-ticket", 1],
    ["develop-prompt", 0],
  ])
    assert.ok(
      html.includes(
        `${String(name)}</strong><span>${String(count)} active · 0 waiting`,
      ),
    );
  assert.match(
    html,
    /<\/header>[\s\S]*<nav class="workflows"[\s\S]*<\/nav><div class="workspace"><main class="board">/,
  );
  const workspace = html.slice(html.indexOf('<div class="workspace">'));
  assert.doesNotMatch(workspace, /<nav|<aside/);
});

await test("CLV-091 stopped cards show exact marks with separate encoded original and later links", () => {
  const model = completionScenario({ stopped: "A /&<b>", later: "B /&<em>" });
  const shown = component(Page, {
    model,
    selected: "workflow=develop-issue",
    now: model.updatedAt,
    stale: false,
    copying: noCopy,
    columns: {
      choices: { Done: false, Stopped: false },
      onToggle: () => undefined,
    },
  });
  const html = rendered(shown);
  assert.match(html, /<section class="column stopped">/);
  assert.match(html, />Done in a later run<\/a>/);
  assert.match(html, />Needs attention<\/span>/);
  assert.match(html, /Title of A \/&amp;&lt;b&gt;/);
  const links = found(shown, "a");
  for (const href of [
    "#workflow=develop-issue&run=A%20%2F%26%3Cb%3E",
    "#workflow=develop-issue&run=B%20%2F%26%3Cem%3E",
  ])
    assert.ok(
      links.some((link) => link["href"] === href),
      href,
    );
  assert.ok(links.every((link) => found(link["children"], "a").length === 0));
  assert.doesNotMatch(
    page(model, "workflow=develop-issue&run=A%20%2F%26%3Cb%3E"),
    /Done in a later run|Needs attention/,
  );
});

await test("CLV-079 the workflow navigation shows counts and selection with ordered columns and cards", () => {
  const model = activeBoardModel();
  const html = page(model, "workflow=develop-issue");
  assert.match(html, /<nav class="workflows" aria-label="Workflows">/);
  assert.match(html, /href="#workflow=develop-issue" aria-current="page"/);
  assert.match(html, /develop-issue<\/strong><span>7 active · 0 waiting/);
  assert.match(html, /develop-ticket<\/strong><span>1 active · 0 waiting/);
  assert.match(html, /develop-prompt<\/strong><span>0 active · 0 waiting/);
  assert.deepEqual(
    [...html.matchAll(/<h3 class="column-name"><span>(.*?)<\/span>/g)].map(
      (match) => match[1],
    ),
    [
      "Work tree",
      "Claude turn",
      "Pull request",
      "Greptile review",
      "Merge",
      "Done",
      "Stopped",
    ],
  );
  assert.match(html, /href="#workflow=develop-issue&amp;run=round-2"/);
  assert.ok(
    html.indexOf("Title of round-2") < html.indexOf("Title of claude-turn"),
  );
  assert.match(html, /aria-label="Collapse Done"/);
  const ticket = page(model, "workflow=develop-ticket");
  assert.deepEqual(
    [...ticket.matchAll(/<h3 class="column-name"><span>(.*?)<\/span>/g)].map(
      (match) => match[1],
    ),
    ["Claude turn", "Your review", "Done", "Stopped"],
  );
  assert.match(ticket, /Title of ticket/);
  assert.doesNotMatch(ticket, /Title of round-2|class="banner|class="run /);
});

function cardPage(
  changes: Partial<WatchCard>,
  options: { readonly column?: string; readonly workflowId?: string } = {},
): string {
  const { column = "Greptile review", workflowId = "develop-issue" } = options;
  const model = activeBoardModel();
  const card: WatchCard = {
    completionMark: null,
    pullRequestObservation: null,
    runId: "run /&1",
    title: "Review the change",
    claudeCostUsd: 1.236,
    estimatedCostUsd: null,
    usage: {
      input_tokens: null,
      cache_read_input_tokens: null,
      output_tokens: null,
    },
    currentStep: { name: "Greptile review", startedAt: "2026-10-14T11:57:00Z" },
    endedAt: null,
    decisionWaiting: true,
    round: 2,
    greptileScore: 4,
    pullRequestNumber: 67,
    ...changes,
  };
  return page(
    {
      ...model,
      workflows: model.workflows.map((workflow) => ({
        ...workflow,
        columns: [{ name: column, cards: [card] }],
      })),
    },
    `workflow=${workflowId}`,
  );
}

await test("CLV-134 cards shorten the run ID, retain the full link title and show one cost without tokens", () => {
  const runId = "123456789012-long-run/&";
  const html = cardPage({
    runId,
    claudeCostUsd: null,
    estimatedCostUsd: 2.2,
    usage: {
      input_tokens: 1800,
      cache_read_input_tokens: 900,
      output_tokens: 170,
    },
  });
  assert.match(html, /<small>123456789012<\/small>/);
  assert.match(html, /title="123456789012-long-run\/&amp;"/);
  assert.match(html, /run=123456789012-long-run%2F%26/);
  assert.match(html, /Totals so far · ≈ 2\.20 USD \(estimate\)/);
  assert.equal(html.match(/USD/g)?.length, 1);
  assert.doesNotMatch(
    html,
    /Input tokens|Cache read tokens|Output tokens|card-usage/,
  );
  assert.match(
    cardPage({ claudeCostUsd: null, estimatedCostUsd: 0 }),
    /≈ 0\.00 USD \(estimate\)/,
  );
  assert.match(cardPage({ estimatedCostUsd: null }), /1\.24 USD/);
});

await test("CLV-079 cards show step time, review progress, cost, decisions and encoded run links", () => {
  const html = cardPage({});
  for (const text of [
    "Review the change",
    "Greptile review · 3 min",
    '<span class="review-pill">round 2</span> · <span class="review-pill">4/5</span> · <span class="review-pill">#67</span>',
    "1.24 USD",
    "Decision waiting",
    "run /&amp;1",
  ])
    assert.ok(html.includes(text), text);
  assert.match(html, /href="#workflow=develop-issue&amp;run=run%20%2F%261"/);
  const board = /<main class="board">[\s\S]*<\/main>/.exec(html)?.[0];
  assert.ok(board);
  assert.doesNotMatch(board, /draggable|<input|<form/);
});

await test("CLV-079 cards omit absent review parts and step time and fall back to the run ID", () => {
  const html = cardPage({
    title: null,
    currentStep: { name: "Work tree", startedAt: null },
    round: null,
    greptileScore: null,
    pullRequestNumber: null,
    decisionWaiting: false,
  });
  assert.match(html, /<strong>run \/&amp;1<\/strong>/);
  assert.match(html, /<span class="card-step active">Work tree<\/span>/);
  assert.doesNotMatch(html, /round |\/5|Decision waiting|Work tree ·/);
  assert.match(
    cardPage({ round: null, pullRequestNumber: null }),
    /<span class="card-review"><span class="review-pill">4\/5<\/span><\/span>/,
  );
});

await test("CLV-079 Done and Stopped cards show the local end date and time instead of a step", () => {
  const endedAt = "2026-10-14T11:57:00Z";
  for (const column of ["Done", "Stopped"]) {
    const html = cardPage({ currentStep: null, endedAt }, { column });
    assert.ok(html.includes(new Date(endedAt).toLocaleString()));
    assert.doesNotMatch(html, /Greptile review ·/);
  }
});

await test("CLV-098 active steps and stopped categories retain their words with distinct presentation", () => {
  assert.match(
    cardPage({}),
    /class="card-step active">Greptile review · 3 min/,
  );
  const stopped = cardPage(
    { endedAt: "2026-10-14T11:57:00Z" },
    { column: "Stopped" },
  );
  assert.match(stopped, /<section class="column stopped">/);
  assert.doesNotMatch(stopped, /card-step active/);
  assert.match(stopped, /1.24 USD/);
  assert.doesNotMatch(cardPage({}, { column: "Done" }), /column stopped/);
});

await test("CLV-098 develop-issue cards render only present review values as separate ordered pills", () => {
  assert.match(
    cardPage({}),
    /<span class="card-review"><span class="review-pill">round 2<\/span> · <span class="review-pill">4\/5<\/span> · <span class="review-pill">#67<\/span><\/span>/,
  );
  assert.match(
    cardPage({ round: null, pullRequestNumber: null }),
    /<span class="card-review"><span class="review-pill">4\/5<\/span><\/span>/,
  );
  assert.doesNotMatch(
    cardPage({ round: null, greptileScore: null, pullRequestNumber: null }),
    /review-pill|card-review/,
  );
  for (const workflow of ["develop-ticket", "develop-prompt"])
    assert.doesNotMatch(
      cardPage({}, { column: "Claude turn", workflowId: workflow }),
      /review-pill|card-review/,
    );
});

await test("CLV-093 PR marks render as escaped text and preserve original and later run links", () => {
  const local = { text: "Needs attention", laterRunId: null };
  const merged = cardPage(
    {
      completionMark: local,
      pullRequestObservation: { status: "merged" },
      pullRequestNumber: 7,
      title: "<b>PR & run</b>",
    },
    { column: "Stopped" },
  );
  assert.match(merged, /<span class="completion-mark">PR merged · #7<\/span>/);
  assert.match(merged, /&lt;b&gt;PR &amp; run&lt;\/b&gt;/);
  assert.match(merged, /href="#workflow=develop-issue&amp;run=run%20%2F%261"/);
  assert.doesNotMatch(merged, />Needs attention</);
  assert.match(
    cardPage({
      completionMark: local,
      pullRequestObservation: { status: "unavailable", failure: "access" },
    }),
    />PR status unavailable<\/span>/,
  );
  for (const observation of [null, { status: "unmerged" }] as const)
    assert.match(
      cardPage({ completionMark: local, pullRequestObservation: observation }),
      />Needs attention<\/span>/,
    );
  assert.match(
    cardPage({
      completionMark: { text: "Done in a later run", laterRunId: "later /&" },
      pullRequestObservation: { status: "merged" },
    }),
    /href="#workflow=develop-issue&amp;run=later%20%2F%26">Done in a later run<\/a>/,
  );
});

await test("CLV-128 declared column labels render in order as escaped text", () => {
  const model = stagedModel([], {
    workflowStages: {
      sample: [
        {
          name: "draft",
          label: '<b>Draft & "input"</b>',
          operations: ["write-draft"],
        },
        { name: "review", label: "Review", gateKinds: ["approval"] },
      ],
    },
  });
  const html = page(model, "workflow=sample");
  assert.match(html, /&lt;b&gt;Draft &amp; &quot;input&quot;&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<b>Draft/);
  assert.ok(html.indexOf("Draft &amp;") < html.indexOf(">Review<"));
  assert.ok(html.indexOf(">Review<") < html.indexOf(">Other<"));
});
