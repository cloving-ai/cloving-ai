import assert from "node:assert/strict";
import { test } from "node:test";
import { operationOf } from "./effect-fixture.ts";
import { component } from "../src/cli/watch-element.ts";
import { Run } from "../src/cli/watch-view.ts";
import { boardModel, boardTime } from "./watch-board-fixture.ts";
import { rendered } from "./watch-dom.ts";
import { noCopy } from "./watch-sample.ts";
import { runStatus } from "../src/cli/render.ts";
import {
  call,
  field,
  parsed,
  withHarness,
  type Harness,
} from "./service-fixture.ts";

async function submit(harness: Harness, commandId: string) {
  const reply = await call(harness, {
    operation: "run",
    parameters: {
      workflowId: "develop",
      source: "input",
      submission: { prompt: "next" },
      commandId,
    },
  });
  return String(reply["runId"]);
}

await test("CLV-308 status shows the position of a run in its chain and the chain limit", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const root = await submit(harness, "position-root");
    const child = await submit(
      harness,
      `handoff:${operationOf(root, { round: 1 })}`,
    );
    const grandchild = await submit(
      harness,
      `handoff:${operationOf(child, { round: 1 })}`,
    );
    for (const [runId, position] of [
      [root, 1],
      [child, 2],
      [grandchild, 3],
    ] as const) {
      const json = await harness.cli(["status", runId, "--json"]);
      assert.equal(json.status, 0, json.stderr);
      assert.deepEqual(field(parsed(json)["run"], "chain"), {
        position,
        limit: 5,
      });
      const plain = await harness.cli(["status", runId]);
      assert.ok(
        plain.stdout.includes(`Chain position: run ${String(position)} of 5\n`),
        plain.stdout,
      );
    }
    await service.close();
  }));

await test("CLV-308 the watch run detail shows the effects, the cost and the chain position", () => {
  const status = {
    runId: "run-limited",
    workflowId: "develop",
    state: "running",
    budget: { spent: 3, limit: 40 },
    claudeCostUsd: 1.25,
    spendLimitUsd: 2,
    chain: { position: 2, limit: 8 },
  };
  const run = boardModel([{ status }]).runs[0];
  assert.ok(run);
  const html = rendered(
    component(Run, { run, now: boardTime, copying: noCopy }),
  );
  assert.match(html, /3 of 40 effect units/);
  assert.match(html, /1\.25 USD \(spend limit 2\.00 USD\)/);
  assert.match(html, /<p class="run-facts">[^]*run 2 of 8<\/p>/);
  assert.match(html, /<dt>Chain<\/dt><dd>run 2 of 8/);
});

await test("CLV-308 the status text shows the cost of a run with its spend limit", () => {
  const cost = (run: Readonly<Record<string, unknown>>) =>
    runStatus({ run }).find((line) => line.startsWith("Cost"));
  assert.equal(
    cost({ state: "running", claudeCostUsd: 1.2, spendLimitUsd: 1 }),
    "Cost so far: 1.20 USD (spend limit 1.00 USD)",
  );
  assert.equal(
    cost({ state: "running", claudeCostUsd: 1.2, spendLimitUsd: null }),
    "Cost so far: 1.20 USD",
  );
});
