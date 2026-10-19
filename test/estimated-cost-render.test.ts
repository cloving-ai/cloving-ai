import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { rendered as cliRendered } from "../src/cli/render.ts";
import { commandUsage } from "../src/cli/usage.ts";
import { component } from "../src/cli/watch-element.ts";
import { Card } from "../src/cli/watch-board-view.ts";
import { Run } from "../src/cli/watch-view.ts";
import { boardModel, boardTime } from "./watch-board-fixture.ts";
import { rendered } from "./watch-dom.ts";
import { played } from "./watch-browser.ts";
import { noCopy } from "./watch-sample.ts";
import { scenarioTotal } from "./worker-report-fixture.ts";

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

await test("CLV-105 CLI shows approximate estimates beside total and turn tokens, preserving unknown reported prices", () => {
  const text = cliRendered({ kind: "run-status", run: status(2.2) });
  assert.match(text, /Claude cost so far: Price not known/);
  assert.match(text, /Worker turn op: Price not known/);
  assert.equal(
    text.match(/Output tokens: 170 · ≈2\.20 USD estimate/g)?.length,
    2,
  );
  assert.doesNotMatch(
    cliRendered({ kind: "run-status", run: status(null) }),
    /estimate/,
  );
  assert.match(
    cliRendered({ kind: "run-status", run: status(0) }),
    /≈0\.00 USD estimate/,
  );
});

await test("CLV-105 watch cards show one estimate while runs retain total and turn tokens", () => {
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
  assert.match(cardHtml, /≈2\.20 USD estimate/);
  assert.equal(cardHtml.match(/USD/g)?.length, 1);
  assert.doesNotMatch(cardHtml, /tokens|Price not known/);
  assert.match(runHtml, /Output tokens: 170 · ≈2\.20 USD estimate/);
  assert.match(runHtml, /Price not known/);
  assert.equal(runHtml.match(/≈2\.20 USD estimate/g)?.length, 2);
});

await test("CLV-105 start help and README describe operator prices without a price table", () => {
  assert.match(
    String(commandUsage["start"]),
    /CLOVING_TOKEN_PRICES +.*JSON object.*million tokens.*no default/,
  );
  assert.match(
    readFileSync(new URL("../README.md", import.meta.url), "utf8"),
    /CLOVING_TOKEN_PRICES.*estimate/,
  );
});

await test("CLV-105 the browser page retains estimates through its serialized rendering helpers", () => {
  const model = boardModel([{ status: status(2.2) }]);
  const result = played(
    model,
    `
replies.push(JSON.parse(process.env.WATCH_MODEL));
await load();
console.log(JSON.stringify({ html: app.inner }));
`,
  );
  assert.match(
    String(result["html"]),
    /Output tokens: 170 · ≈2\.20 USD estimate/,
  );
  assert.match(String(result["html"]), /Price not known/);
});
