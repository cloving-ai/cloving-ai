import assert from "node:assert/strict";
import { test } from "node:test";
import { Card } from "../src/cli/watch-board-view.ts";
import { boardModel } from "./watch-board-fixture.ts";
import { found, rendered } from "./watch-dom.ts";
import {
  call,
  field,
  items,
  parsed,
  startedRun,
  withHarness,
} from "./service-fixture.ts";

await test("CLV-180 status and run cards show the durable wait and awaited run", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const runId = await startedRun(harness, { service, commandId: "waiting" });
    const awaitedRunId = "child-run";
    assert.equal(
      (
        await service.worker.observe({
          runId,
          commandId: "wait",
          condition: "waiting-run",
          reason: "awaiting-run",
          evidence: awaitedRunId,
          retryAt: "2026-10-26T12:00:00.000Z",
        })
      ).kind,
      "accepted",
    );
    await service.close();
    const reopened = await harness.start();
    const json = await harness.cli(["status", runId, "--json"]);
    assert.equal(json.status, 0, json.stderr);
    const status = field(parsed(json), "run");
    assert.equal(field(status, "condition"), "waiting-run");
    assert.equal(field(status, "awaitedRunId"), awaitedRunId);
    const plain = await harness.cli(["status", runId]);
    assert.equal(plain.status, 0, plain.stderr);
    assert.match(plain.stdout, /^Awaited run: child-run$/m);
    const listed = await call(harness, { operation: "status", parameters: {} });
    const model = boardModel([{ status, events: [] }], {
      workflows: ["develop"],
      summaries: items(field(listed, "runs")),
    });
    assert.equal(model.runs[0]?.awaitedRunId, awaitedRunId);
    assert.equal(model.workflows[0]?.waitingCount, 1);
    const card = model.workflows.flatMap((workflow) =>
      workflow.columns.flatMap((column) => column.cards),
    )[0];
    assert.ok(card);
    const shown = Card({ card, workflowId: "develop", now: model.updatedAt });
    assert.match(rendered(shown), /Waiting for run: child-run/);
    assert.ok(
      found(shown, "a").some((link) => link["href"] === "#run=child-run"),
    );
    await reopened.close();
  }));
