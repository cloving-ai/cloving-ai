import assert from "node:assert/strict";
import { test } from "node:test";
import { documentDigest } from "../src/broker/decision-restore.ts";
import { feedWorkflow } from "./service-feed-fixture.ts";
import { call, field, text, withHarness } from "./service-fixture.ts";
import { queryDatabase } from "./authority-store-fixture.ts";

function start(commandId: string, workflowId = "develop") {
  return { operation: "queue-feed", parameters: { workflowId, commandId } };
}

function status(runId: unknown) {
  return { operation: "queue-feed", parameters: { action: "status", runId } };
}

await test("CLV-362 one internal feed runs at a time, replays durably, and stores its bounded result document", () =>
  withHarness(async (harness) => {
    const workflows = [feedWorkflow(harness.registration)];
    const service = await harness.start({ workflows });
    const first = await call(harness, start("first"));
    assert.equal(first["kind"], "run-admitted");
    const runId = text(first, "runId");
    assert.equal((await call(harness, start("second")))["code"], "feed-active");
    assert.equal((await call(harness, start("first")))["replayed"], true);
    assert.equal((await call(harness, status(runId)))["state"], "queued");
    assert.deepEqual(
      (await call(harness, { operation: "status", parameters: {} }))["runs"],
      [],
    );
    assert.equal(
      (
        await service.worker.started({
          commandId: "start",
          runId,
          expectedRevision: 1,
        })
      ).kind,
      "accepted",
    );
    const result = {
      picks: [{ id: "900", text: "a".repeat(65_536) }],
      skipped: [{ id: "901", reason: "wait" }],
    };
    const body = JSON.stringify(result);
    assert.equal(
      (
        await service.worker.submit(
          {
            kind: "complete-run",
            commandId: "end",
            runId,
            expectedRevision: 2,
            result: documentDigest(body),
          },
          [body],
        )
      ).kind,
      "accepted",
    );
    const finished = await call(harness, status(runId));
    assert.deepEqual(finished["result"], result);
    assert.equal(typeof finished["at"], "string");
    await service.close();
    assert.ok(
      queryDatabase(harness.stateDirectory, "SELECT body FROM documents").some(
        (row) => field(row, "body") === body,
      ),
    );
    await harness.start({ workflows });
    assert.equal((await call(harness, start("first")))["replayed"], true);
    assert.deepEqual((await call(harness, status(runId)))["result"], result);
    assert.equal((await call(harness, start("after")))["kind"], "run-admitted");
    assert.deepEqual(harness.resolved, []);
  }));

await test("CLV-362 internal feed requests reject missing declarations, malformed identities and foreign run IDs", () =>
  withHarness(async (harness) => {
    await harness.start({ workflows: [harness.registration] });
    assert.equal(
      (await call(harness, start("missing")))["code"],
      "queue-feed-missing",
    );
    assert.equal(
      (await call(harness, start("invalid", "bad id")))["code"],
      "invalid-request",
    );
    assert.equal(
      (await call(harness, status(undefined)))["code"],
      "invalid-request",
    );
    assert.equal(
      (await call(harness, status("run-unknown")))["code"],
      "unknown-run",
    );
  }));

await test("CLV-362 unavailable workflows and the spend limit prevent internal feeds", () =>
  withHarness(async (harness) => {
    const workflow = feedWorkflow(harness.registration);
    let service = await harness.start({
      workflows: [{ ...workflow, availability: "unavailable" }],
    });
    assert.equal(
      (await call(harness, start("unavailable")))["code"],
      "workflow-unavailable",
    );
    await service.close();
    service = await harness.start({
      workflows: [workflow],
      queueDailySpendLimitUsd: 0,
    });
    assert.equal(
      (await call(harness, start("spent")))["code"],
      "queue-spend-limit",
    );
    await service.close();
  }));

await test("CLV-362 a full workflow prevents a feed and reused work command IDs conflict", () =>
  withHarness(async (harness) => {
    const workflow = feedWorkflow(harness.registration);
    await harness.start({ workflows: [workflow] });
    for (const id of ["900", "901"]) {
      assert.equal(
        (
          await call(harness, {
            operation: "run",
            parameters: {
              workflowId: "develop",
              commandId: id,
              source: "feed",
              submission: { ticket: { id, text: "Task" } },
            },
          })
        )["kind"],
        "run-admitted",
      );
    }
    assert.equal(
      (await call(harness, start("900")))["code"],
      "conflicting-command",
    );
    assert.equal(
      (await call(harness, start("full")))["code"],
      "workflow-active",
    );
  }));

await test("CLV-362 a completed feed without a valid result refuses the cycle", () =>
  withHarness(async (harness) => {
    const service = await harness.start({
      workflows: [feedWorkflow(harness.registration)],
    });
    const first = await call(harness, start("invalid-result"));
    const runId = text(first, "runId");
    await service.worker.started({
      commandId: "start",
      runId,
      expectedRevision: 1,
    });
    await service.worker.completed({
      commandId: "end",
      runId,
      expectedRevision: 2,
    });
    assert.equal(
      (await call(harness, status(runId)))["code"],
      "invalid-feed-result",
    );
    assert.equal((await call(harness, start("new")))["kind"], "run-admitted");
  }));
