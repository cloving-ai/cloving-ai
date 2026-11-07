import assert from "node:assert/strict";
import { test } from "node:test";
import { rendered as cliRendered } from "../src/cli/render.ts";
import { component } from "../src/cli/watch-element.ts";
import { Run } from "../src/cli/watch-view.ts";
import { boardModel, boardTime } from "./watch-board-fixture.ts";
import { rendered } from "./watch-dom.ts";
import { noCopy } from "./watch-sample.ts";

const continuedLine =
  "Cost of the continued turns: 19.17 USD (counted in the earlier run)";

function continuation(continuedCostUsd?: number | null) {
  return {
    runId: "run-new",
    workflowId: "develop-issue",
    state: "completed",
    continuedFrom: "run-old",
    claudeCostUsd: 2,
    estimatedCostUsd: null,
    ...(continuedCostUsd === undefined ? {} : { continuedCostUsd }),
    workerTurns: [
      { operationId: "turn-old", costUsd: 19.17, reused: true },
      { operationId: "turn-new", costUsd: 2 },
    ],
  };
}

function detail(status: Readonly<Record<string, unknown>>): string {
  const run = boardModel([{ status }]).runs[0];
  assert.ok(run);
  return rendered(component(Run, { run, now: boardTime, copying: noCopy }));
}

await test("CLV-321 status shows the cost of the own turns of a continuation and the cost of its continued turns apart", () => {
  const text = cliRendered({ kind: "run-status", run: continuation(19.17) });
  assert.match(text, /^Cost: 2\.00 USD$/m);
  assert.match(
    text,
    new RegExp(`^${continuedLine.replace(/[.()]/g, "\\$&")}$`, "m"),
  );
  assert.match(
    cliRendered({ kind: "run-status", run: continuation(null) }),
    /^Cost of the continued turns: Price not known \(counted in the earlier run\)$/m,
  );
  assert.doesNotMatch(
    cliRendered({ kind: "run-status", run: continuation() }),
    /continued turns/,
  );
});

await test("CLV-321 the run detail shows the cost of the own turns of a continuation and the cost of its continued turns apart", () => {
  const html = detail(continuation(19.17));
  assert.match(
    html,
    new RegExp(
      `<p>2\\.00 USD</p><p>${continuedLine.replace(/[.()]/g, "\\$&")}</p>`,
    ),
  );
  assert.doesNotMatch(detail(continuation()), /continued turns/);
});
