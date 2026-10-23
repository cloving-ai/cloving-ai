import assert from "node:assert/strict";
import { test } from "node:test";
import { rendered, statusJson } from "../src/cli/render.ts";
import { completedDetail } from "../src/cli/watch-render.ts";
import { boardModel } from "./watch-board-fixture.ts";
import {
  call,
  field,
  parsed,
  startedRun,
  withHarness,
} from "./service-fixture.ts";

await test("CLV-168 promotion identity survives service restart and reaches status text, JSON and watch", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const runId = await startedRun(harness, { service, commandId: "promoted" });
    assert.equal(
      (
        await service.worker.submit({
          kind: "complete-run",
          commandId: "completed",
          runId,
          expectedRevision: 2,
          outcome: "handoff_requested",
          promotionId: "pull-request-7",
        })
      ).kind,
      "accepted",
    );
    await service.close();
    const reopened = await harness.start();
    const status = await call(harness, {
      operation: "status",
      parameters: { runId },
    });
    const outcome = {
      kind: "handoff_requested",
      reason: null,
      promotionId: "pull-request-7",
    };
    assert.deepEqual(field(field(status, "run"), "outcome"), outcome);
    const plain = await harness.cli(["status", runId]);
    assert.equal(plain.status, 0, plain.stderr);
    assert.match(plain.stdout, /^Promotion: pull-request-7$/m);
    const json = await harness.cli(["status", runId, "--json"]);
    assert.equal(json.status, 0, json.stderr);
    assert.deepEqual(field(field(parsed(json), "run"), "outcome"), outcome);
    const model = boardModel([{ status: field(status, "run"), events: [] }]);
    const [run] = model.runs;
    assert.ok(run);
    assert.equal(field(run, "promotionId"), "pull-request-7");
    assert.match(completedDetail(run), /Promotion: pull-request-7/);
    await reopened.close();
  }));

await test("CLV-168 absent promotion IDs stay absent in old status and watch data", () => {
  const outcome = { kind: "handoff_requested", reason: null };
  const result = { kind: "run-status", run: { outcome } };
  assert.deepEqual(field(field(statusJson(result), "run"), "outcome"), outcome);
  assert.doesNotMatch(rendered(result), /Promotion:/);
  for (const promotionId of [undefined, null, 7, "", "bad/id"]) {
    const model = boardModel([
      { status: { outcome: { ...outcome, promotionId } }, events: [] },
    ]);
    const [run] = model.runs;
    assert.ok(run);
    assert.equal(Object.hasOwn(run, "promotionId"), false);
    assert.doesNotMatch(completedDetail(run), /Promotion:/);
  }
});
