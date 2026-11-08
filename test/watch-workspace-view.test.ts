import assert from "node:assert/strict";
import { test } from "node:test";
import { component } from "../src/cli/watch-element.ts";
import type { WatchModel } from "../src/cli/watch-render.ts";
import { Page } from "../src/cli/watch-view.ts";
import { watchHash, watchLocation } from "../src/cli/watch-navigation.ts";
import { workspaceModel } from "../src/cli/watch-workspace.ts";
import type { DailyNumbers } from "../src/report-days.ts";
import { rendered } from "./watch-dom.ts";
import {
  decisionFor,
  draftRun,
  floorModel,
  floorRun,
} from "./watch-floor-fixture.ts";
import { noCopy } from "./watch-sample.ts";

function page(model: WatchModel, selected = ""): string {
  return rendered(
    component(Page, {
      model,
      selected,
      now: model.updatedAt,
      stale: false,
      copying: noCopy,
    }),
  );
}

function numbers(completed: number, costUsd: number): DailyNumbers {
  return {
    completed,
    stopped: 0,
    costUsd,
    unknownCostRuns: 0,
    knownCostCompleted: completed,
    costPerCompletedRunUsd: completed === 0 ? null : costUsd / completed,
    yesterday: { completed: 0, costUsd: 0, unknownCostRuns: 0 },
    days: [{ date: "2026-11-08", completed }],
    workflows: [],
  };
}

function twoRepositories(): WatchModel {
  return workspaceModel([
    {
      name: "alpha",
      model: floorModel(
        [floorRun("alpha-run", { operation: "claude-turn", minutes: 4 })],
        { today: numbers(2, 3) },
      ),
    },
    {
      name: "beta",
      model: floorModel([draftRun(5)], {
        service: "down",
        decisions: [decisionFor("draft", { minutes: 5 })],
        today: numbers(1, 1.5),
      }),
    },
  ]);
}

function groups(html: string): readonly string[] {
  return html.split('<li class="repository">').slice(1);
}

await test("CLV-312 the workspace floor shows one group of lines for each repository, with the repository name", () => {
  const html = page(twoRepositories());
  const [alpha = "", beta = ""] = groups(html);
  assert.equal(groups(html).length, 2);
  assert.match(alpha, /^<h3 class="repository-name">alpha<\/h3>/);
  assert.match(
    beta,
    /^<h3 class="repository-name">beta<\/h3><span class="repository-down">The service does not answer\.<\/span>/,
  );
  for (const group of [alpha, beta])
    assert.equal(group.split('<li class="line">').length - 1, 2);
  assert.match(alpha, /href="#run=alpha-run"/);
  assert.doesNotMatch(alpha, /href="#run=draft"/);
  assert.match(beta, /href="#run=draft"/);
  assert.match(
    beta,
    /href="#workflow=develop-issue&amp;repository=beta">develop-issue<\/a>/,
  );
});

await test("CLV-312 a single repository floor shows no repository groups", () => {
  const html = page(floorModel([]));
  assert.doesNotMatch(html, /class="repository"|class="repositories"/);
});

await test("CLV-312 a board location can name the repository of the workflow", () => {
  const location = { workflowId: "idea", runId: null, repository: "beta" };
  assert.equal(watchHash(location), "#workflow=idea&repository=beta");
  assert.deepEqual(watchLocation("#workflow=idea&repository=beta"), location);
  assert.deepEqual(watchLocation("#workflow=idea"), {
    workflowId: "idea",
    runId: null,
  });
  const board = page(twoRepositories(), "#workflow=idea&repository=beta");
  assert.match(board, /class="board-page"/);
  assert.match(board, /draft/);
  const other = page(twoRepositories(), "#workflow=idea&repository=alpha");
  assert.match(other, /class="board-page"/);
  assert.doesNotMatch(other, /#run=draft/);
});

await test("CLV-312 a board card and the back link of its run keep the repository of the board", () => {
  const board = page(twoRepositories(), "#workflow=idea&repository=beta");
  assert.match(
    board,
    /class="card-run" href="#workflow=idea&amp;repository=beta&amp;run=draft"/,
  );
  const run = page(
    twoRepositories(),
    "#workflow=idea&repository=beta&run=draft",
  );
  assert.match(
    run,
    /<a class="back" href="#workflow=idea&amp;repository=beta">← Back to idea<\/a>/,
  );
});

await test("CLV-312 the later-run link of a board card keeps the repository of the board", () => {
  const model = twoRepositories();
  const later = { text: "Ticket completed by later run", laterRunId: "later" };
  const marked: WatchModel = {
    ...model,
    workflows: model.workflows.map((workflow) => ({
      ...workflow,
      columns: workflow.columns.map((column) => ({
        ...column,
        cards: column.cards.map((card) => ({
          ...card,
          completionMark: later,
        })),
      })),
    })),
  };
  assert.match(
    page(marked, "#workflow=idea&repository=beta"),
    /class="completion-mark" href="#workflow=idea&amp;repository=beta&amp;run=later"/,
  );
});

await test("CLV-312 Needs you names the repository of each item", () => {
  const html = page(twoRepositories());
  assert.deepEqual(
    [...html.matchAll(/<p class="need-meta">([^<]*)</g)].map(
      (match) => match[1],
    ),
    ["beta: idea, waiting 5m"],
  );
});

await test("CLV-312 the workspace Today panel shows the totals and one row for each repository", () => {
  const html = page(twoRepositories());
  assert.match(
    html,
    /<strong>3<\/strong><span class="today-label">runs completed/,
  );
  assert.match(
    html,
    /<h3>By repository<\/h3><table class="today-table"><thead><tr><th scope="col">Repository<\/th><th scope="col">Done<\/th><th scope="col">Spent<\/th><\/tr><\/thead><tbody><tr><th scope="row">alpha<\/th><td>2<\/td><td>\$3\.00<\/td><\/tr><tr><th scope="row">beta<\/th><td>1<\/td><td>\$1\.50<\/td><\/tr><\/tbody><\/table>/,
  );
  assert.doesNotMatch(html, /By line/);
});
