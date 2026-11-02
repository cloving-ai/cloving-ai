import assert from "node:assert/strict";
import { test } from "node:test";
import { rendered as cliRendered, statusJson } from "../src/cli/render.ts";
import { component } from "../src/cli/watch-element.ts";
import { Turn } from "../src/cli/watch-turn.ts";
import { turnOf } from "../src/cli/watch-model.ts";
import { boardModel, boardTime } from "./watch-board-fixture.ts";
import { rendered } from "./watch-dom.ts";
import { played } from "./watch-browser.ts";
import { field, items, withHarness } from "./service-fixture.ts";
import { view } from "./service-views.ts";
import {
  reportTurn,
  workerScene,
  scenarioTotal,
} from "./worker-report-fixture.ts";

const attempts = ["capacity", "network", null, undefined].map(
  (retryKind, index) => ({
    attempt: index + 1,
    model: "main",
    usage: scenarioTotal,
    costUsd: [1.2, 0.8, 0.5, 0][index] ?? 0,
    estimatedCostUsd: null,
    ...(retryKind === undefined ? {} : { retryKind }),
    ...(index === 1 ? { resumedAfter: "daemon-restart" as const } : {}),
  }),
);

await test("CLV-229 status JSON retains kinds and leaves older attempts without a kind", () =>
  withHarness(async (harness) => {
    const scene = await workerScene(harness);
    await reportTurn(scene, {
      round: 1,
      result: JSON.stringify({ attempts, usage: scenarioTotal, costUsd: 2.5 }),
    });
    const status = await view(harness, scene.runId);
    assert.equal(field(status, "claudeCostUsd"), 2.5);
    const turns = items(field(status, "workerTurns"));
    const saved = items(field(turns[0], "attempts"));
    assert.deepEqual(saved, attempts);
    const json = statusJson({ kind: "run-status", run: status });
    assert.deepEqual(
      field(items(field(field(json, "run"), "workerTurns"))[0], "attempts"),
      attempts,
    );
    await scene.service.close();
  }));

await test("CLV-229 status text and watch list each attempt kind including null, with no inferred older kind", () => {
  const status = {
    runId: "run-1",
    workflowId: "develop-ticket",
    state: "completed",
    workerTurns: [
      { operationId: "op", attempts, usage: scenarioTotal, costUsd: 1 },
    ],
  };
  const text = cliRendered({ kind: "run-status", run: status });
  const run = boardModel([{ status }]).runs[0];
  assert.ok(run?.turns[0]);
  assert.deepEqual(run.turns[0].attempts, attempts);
  const html = rendered(
    component(Turn, { turn: run.turns[0], now: boardTime }),
  );
  for (const shown of [text, html]) {
    assert.match(shown, /Attempt 1.*retryKind: capacity/);
    assert.match(shown, /Attempt 2.*retryKind: network/);
    assert.match(shown, /Attempt 2[^\n<]*resumedAfter: daemon-restart/);
    assert.doesNotMatch(shown, /Attempt [134][^\n<]*resumedAfter/);
    assert.match(shown, /Attempt 3.*retryKind: null/);
    assert.doesNotMatch(shown, /Attempt 4[^\n<]*retryKind/);
    assert.match(shown, /Attempt 4/);
  }
});

await test("CLV-229 watch journal reads completed attempts but shows no kinds during a wait", () => {
  const records = {
    key: "op",
    started: {
      operationId: JSON.stringify(["operation", 1, "run-1"]),
      phase: "waiting",
    },
    result: { outcome: "completed", result: JSON.stringify({ attempts }) },
    activity: [],
  };
  assert.deepEqual(turnOf(records).attempts, attempts);
  const waiting = turnOf({ ...records, result: null });
  assert.equal(waiting.attempts, undefined);
  const html = rendered(component(Turn, { turn: waiting, now: boardTime }));
  assert.doesNotMatch(html, /retryKind|Attempt 1/);
});

await test("CLV-229 the serialized watch page renders retry kinds in the browser", () => {
  const model = boardModel([
    {
      status: {
        runId: "run-1",
        workflowId: "develop-ticket",
        state: "completed",
        workerTurns: [
          { operationId: "op", attempts, usage: scenarioTotal, costUsd: 1 },
        ],
      },
    },
  ]);
  const result = played(
    model,
    `
replies.push(JSON.parse(process.env.WATCH_MODEL));
await load();
console.log(JSON.stringify({ html: app.inner }));
`,
  );
  assert.match(String(result["html"]), /Attempt 2.*retryKind: network/);
  assert.match(
    String(result["html"]),
    /Attempt 2[^<]*resumedAfter: daemon-restart/,
  );
});
