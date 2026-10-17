import assert from "node:assert/strict";
import { test } from "node:test";
import { activityOf, turnOf } from "../src/cli/watch-model.ts";
import { component } from "../src/cli/watch-element.ts";
import { Card } from "../src/cli/watch-board-view.ts";
import { Run } from "../src/cli/watch-view.ts";
import {
  completedDetail,
  pageTitle,
  runName,
} from "../src/cli/watch-render.ts";
import { rendered } from "./watch-dom.ts";
import { boardModel, boardTime } from "./watch-board-fixture.ts";
import { sampleRun, sampleTurn, noCopy } from "./watch-sample.ts";
import {
  scenarioUsage,
  scenarioTotal,
  unknownUsage,
} from "./worker-report-fixture.ts";

function scenario() {
  const workerTurns = scenarioUsage.map((usage, index) => ({
    operationId: JSON.stringify([
      "cloving-operation",
      index + 1,
      "run-1",
      "work",
      "claude-turn",
    ]),
    usage,
    costUsd: null,
  }));
  const turns = workerTurns.map((turn, index) =>
    turnOf({
      key: String(index),
      started: { operationId: turn.operationId },
      result: {
        outcome: index === 0 ? "completed" : "failed",
        result: JSON.stringify(turn),
      },
      lines: ['{"type":"result","result":"Done.","total_cost_usd":9}'],
    }),
  );
  return boardModel(
    [
      {
        status: {
          runId: "run-1",
          workflowId: "develop-issue",
          state: "running",
          claudeCostUsd: null,
          usage: scenarioTotal,
          workerTurns,
        },
      },
    ],
    { turns },
  );
}

await test("CLV-094 watch cards, run totals, turn headings and result activity show usage and unknown price", () => {
  const model = scenario();
  const run = model.runs[0];
  const card = model.workflows[0]?.columns.flatMap((column) => column.cards)[0];
  assert.ok(run && card);
  assert.deepEqual(run.usage, scenarioTotal);
  assert.deepEqual(card.usage, scenarioTotal);
  assert.equal(card.claudeCostUsd, null);
  const cardHtml = rendered(
    component(Card, { card, workflowId: "develop-issue", now: boardTime }),
  );
  const runHtml = rendered(
    component(Run, { run, now: boardTime, copying: noCopy }),
  );
  for (const html of [cardHtml, runHtml]) {
    assert.match(html, /so far/);
    assert.match(
      html,
      /Input tokens: 1800 · Cache read tokens: 900 · Output tokens: 170/,
    );
    assert.match(html, /Price not known/);
    assert.doesNotMatch(html, /\d+\.\d+ USD/);
  }
  for (const usage of scenarioUsage)
    assert.ok(
      runHtml.includes(
        `Input tokens: ${String(usage.input_tokens)} · Cache read tokens: ${String(usage.cache_read_input_tokens)} · Output tokens: ${String(usage.output_tokens)}`,
      ),
    );
  for (const turn of run.turns) {
    assert.equal(turn.costUsd, null);
    assert.ok(turn.operationId);
    assert.match(turn.activity.at(-1)?.text ?? "", /Price not known/);
  }
});

await test("CLV-094 old raw logs cannot restore invalid prices, unknown stored totals or missing usage", () => {
  for (const costUsd of [undefined, null, -1, "2", Infinity]) {
    const turn = turnOf({
      key: "k",
      started: {},
      result: { outcome: "completed", result: JSON.stringify({ costUsd }) },
      lines: ['{"type":"result","total_cost_usd":9}'],
    });
    assert.equal(turn.costUsd, null);
    assert.deepEqual(turn.usage, unknownUsage);
  }
  for (const total_cost_usd of [undefined, null, -1, "2", Infinity])
    assert.deepEqual(
      activityOf(
        JSON.stringify({ type: "result", result: "Done.", total_cost_usd }),
      ),
      [{ kind: "result", text: "Done." }],
    );
  assert.deepEqual(activityOf('{"type":"result","total_cost_usd":1e400}'), [
    { kind: "result", text: "" },
  ]);
  const raw = sampleTurn({
    operationId: "op",
    outcome: "completed",
    costUsd: 9,
  });
  const model = boardModel(
    [
      {
        status: {
          runId: "run-1",
          claudeCostUsd: null,
          workerTurns: [
            {
              operationId: "op",
              usage: { input_tokens: 0, output_tokens: -1 },
              costUsd: null,
            },
          ],
        },
      },
    ],
    { turns: [raw] },
  );
  assert.equal(model.runs[0]?.claudeCostUsd, null);
  assert.equal(model.runs[0].turns[0]?.costUsd, null);
  assert.deepEqual(model.runs[0].turns[0].usage, {
    ...unknownUsage,
    input_tokens: 0,
  });
});

await test("CLV-094 persisted turn entries remain visible without local logs and completion uses the stored run price", () => {
  const model = boardModel([
    {
      status: {
        runId: "run-1",
        workerTurns: [{ operationId: "op", usage: scenarioTotal, costUsd: 0 }],
      },
    },
  ]);
  assert.equal(model.runs[0]?.turns[0]?.operationId, "op");
  assert.deepEqual(model.runs[0].turns[0].usage, scenarioTotal);
  for (const [claudeCostUsd, price] of [
    [null, "Price not known"],
    [-1, "Price not known"],
    [Infinity, "Price not known"],
    [0, "0.00 USD"],
    [1.25, "1.25 USD"],
  ] as const) {
    const run = sampleRun({
      state: "completed",
      claudeCostUsd,
      turns: [sampleTurn({ costUsd: 100 })],
    });
    const text = completedDetail(run);
    assert.ok(text.includes(price));
    assert.doesNotMatch(text, /100\.00 USD/);
  }
});

await test("CLV-094 persisted ended turns override a stale active journal and preserve unrelated active turns", () => {
  for (const costUsd of [0, 0.25]) {
    const operationId = '["cloving-operation",1,"run-1"]';
    const journal = turnOf({
      key: "k",
      started: { operationId },
      result: null,
      lines: [
        '{"type":"assistant","message":{"content":[{"type":"text","text":"Working."}]}}',
        '{"type":"result","result":"Done.","total_cost_usd":9}',
      ],
    });
    const model = boardModel(
      [
        {
          status: {
            runId: "run-1",
            usage: scenarioTotal,
            claudeCostUsd: costUsd,
            workerTurns: [{ operationId, usage: scenarioTotal, costUsd }],
          },
        },
      ],
      {
        turns: [journal, sampleTurn({ operationId: "still-active" })],
      },
    );
    const run = model.runs[0];
    assert.ok(run);
    assert.equal(run.turns.length, 2);
    assert.equal(run.turns[0]?.outcome, "ended");
    assert.equal(run.turns[0].activeAt, null);
    assert.equal(run.turns[0].costUsd, costUsd);
    assert.equal(run.turns[0].activity[0]?.text, "Working.");
    assert.equal(
      run.turns[0].activity[1]?.text,
      `Done. (cost ${costUsd.toFixed(2)} USD)`,
    );
    assert.equal(run.turns[1]?.outcome, "in work");
  }
});

await test("CLV-094 a run restored without local logs retains its identity in the heading and browser title", () => {
  const model = boardModel([
    { status: { runId: "restored-run", workerTurns: [{ operationId: "op" }] } },
  ]);
  const run = model.runs[0];
  assert.ok(run);
  assert.equal(runName(run), "restored-run");
  assert.match(pageTitle(model, "restored-run"), / · restored-run · Cloving$/);
});
