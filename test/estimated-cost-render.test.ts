import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { rendered as cliRendered, statusJson } from "../src/cli/render.ts";
import { commandUsage } from "../src/cli/usage.ts";
import { component } from "../src/cli/watch-element.ts";
import { Card } from "../src/cli/watch-board-view.ts";
import { Run } from "../src/cli/watch-view.ts";
import { boardModel, boardTime } from "./watch-board-fixture.ts";
import { rendered } from "./watch-dom.ts";
import { played } from "./watch-browser.ts";
import { noCopy } from "./watch-sample.ts";
import { scenarioTotal } from "./worker-report-fixture.ts";
import { priceText } from "../src/cli/usage-render.ts";
import { completedDetail } from "../src/cli/watch-render.ts";

await test("CLV-133 cost display prefers reported prices, then estimates, then unknown", () => {
  assert.equal(priceText(1.25, 7.82), "1.25 USD");
  assert.equal(priceText(0, 7.82), "0.00 USD");
  assert.equal(priceText(null, 7.82), "≈ 7.82 USD (estimate)");
  assert.equal(priceText(undefined, 0), "≈ 0.00 USD (estimate)");
  for (const invalid of [null, undefined, -1, Infinity, NaN, "1.25"])
    assert.equal(priceText(invalid, invalid), "Price not known");
});

function status(estimate: number | null) {
  return {
    runId: "run-1",
    workflowId: "develop-issue",
    state: "running",
    claudeCostUsd: null,
    estimatedCostUsd: estimate,
    usage: scenarioTotal,
    workerTurns: [
      {
        operationId: "op",
        costUsd: null,
        estimatedCostUsd: estimate,
        usage: scenarioTotal,
      },
    ],
  };
}

await test("CLV-133 CLI shows estimates in total and turn costs without repeating them in tokens", () => {
  const text = cliRendered({ kind: "run-status", run: status(2.2) });
  assert.match(text, /^Cost so far: ≈ 2\.20 USD \(estimate\)$/m);
  assert.match(text, /^Worker turn op: ≈ 2\.20 USD \(estimate\)$/m);
  assert.equal(text.match(/Output tokens: 170$/gm)?.length, 2);
  assert.doesNotMatch(text, /Claude cost|Price not known/);
  assert.doesNotMatch(
    cliRendered({ kind: "run-status", run: status(null) }),
    /estimate/,
  );
  assert.match(
    cliRendered({ kind: "run-status", run: status(0) }),
    /≈ 0\.00 USD \(estimate\)/,
  );
  assert.match(
    cliRendered({
      kind: "run-status",
      run: { ...status(2.2), state: "completed", claudeCostUsd: 0.25 },
    }),
    /^Cost: 0\.25 USD$/m,
  );
});

await test("CLV-133 watch cards and run totals and turns use estimates in their cost places", () => {
  const model = boardModel([{ status: status(2.2) }]);
  const run = model.runs[0];
  const card = model.workflows[0]?.columns.flatMap((column) => column.cards)[0];
  assert.ok(run && card);
  assert.equal(run.estimatedCostUsd, 2.2);
  assert.equal(run.turns[0]?.estimatedCostUsd, 2.2);
  const runHtml = rendered(
    component(Run, { run, now: boardTime, copying: noCopy }),
  );
  const cardHtml = rendered(
    component(Card, { card, workflowId: "develop-issue", now: boardTime }),
  );
  assert.match(cardHtml, /Totals so far · ≈ 2\.20 USD \(estimate\)/);
  assert.equal(cardHtml.match(/USD/g)?.length, 1);
  assert.doesNotMatch(cardHtml, /tokens|Price not known/);
  assert.match(runHtml, /<p>≈ 2\.20 USD \(estimate\)<\/p>/);
  assert.match(runHtml, /code-head">Agent turn · .*≈ 2\.20 USD \(estimate\)/);
  assert.match(runHtml, /Output tokens: 170<\/p>/);
  assert.doesNotMatch(runHtml, /Price not known/);
  assert.equal(runHtml.match(/≈ 2\.20 USD \(estimate\)/g)?.length, 2);
});

await test("CLV-133 help and README describe dated built-in prices and model overrides", () => {
  assert.match(
    String(commandUsage["start"]),
    /CLOVING_TOKEN_PRICES +.*JSON object.*million tokens.*built-in/,
  );
  assert.match(
    readFileSync(new URL("../README.md", import.meta.url), "utf8"),
    /2026-10-18.*https:\/\/openai\.com\/api\/pricing\//,
  );
});

await test("CLV-133 watch costs prefer reported prices including zero and completed banners use estimates", () => {
  for (const reported of [0, 0.25, null]) {
    const model = boardModel([
      {
        status: {
          ...status(2.2),
          state: "completed",
          latestAt: boardTime,
          outcome: { kind: "handoff_requested" },
          claudeCostUsd: reported,
          workerTurns: [{ ...status(2.2).workerTurns[0], costUsd: reported }],
        },
      },
    ]);
    const run = model.runs[0];
    const card = model.workflows[0]?.columns.flatMap(
      (column) => column.cards,
    )[0];
    assert.ok(run && card);
    const cost =
      reported === null
        ? "≈ 2.20 USD (estimate)"
        : `${reported.toFixed(2)} USD`;
    const cardHtml = rendered(
      component(Card, { card, workflowId: "develop-issue", now: boardTime }),
    );
    const runHtml = rendered(
      component(Run, { run, now: boardTime, copying: noCopy }),
    );
    assert.ok(cardHtml.includes(`Totals · ${cost}`));
    assert.ok(runHtml.includes(`<p>${cost}</p>`));
    assert.ok(completedDetail(run).includes(`cost ${cost}.`));
    assert.equal(runHtml.includes("(estimate)"), reported === null);
  }
});

await test("CLV-133 JSON presentation preserves other replies and incomplete status data", () => {
  for (const result of [
    { kind: "run-list", runs: [] },
    { kind: "run-status", run: null },
  ])
    assert.equal(statusJson(result), result);
  for (const workerTurns of [undefined, null, [null, "old-turn"]]) {
    const result = { kind: "run-status", run: { workerTurns } };
    assert.deepEqual(statusJson(result), {
      kind: "run-status",
      run: { workerTurns, costDisplay: "Price not known" },
    });
    assert.deepEqual(result.run, { workerTurns });
  }
});

await test("CLV-133 the browser page retains cost estimates through its serialized rendering helpers", () => {
  const model = boardModel([{ status: status(2.2) }]);
  const result = played(
    model,
    `
replies.push(JSON.parse(process.env.WATCH_MODEL));
await load();
console.log(JSON.stringify({ html: app.inner }));
`,
  );
  assert.match(String(result["html"]), /<p>≈ 2\.20 USD \(estimate\)<\/p>/);
  assert.doesNotMatch(String(result["html"]), /Price not known/);
});
