import assert from "node:assert/strict";
import { test } from "node:test";
import { queueOffPort } from "../src/daemon/queue-control.ts";
import {
  call,
  field,
  text,
  items,
  startedRun,
  withHarness,
} from "./service-fixture.ts";

await test("CLV-244 workflow metadata batches contain only identities and preserve missing runs", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const runId = await startedRun(harness, {
      service,
      commandId: "workflow-metadata",
    });
    const reply = await call(harness, {
      operation: "status",
      parameters: { metadata: "workflows", runIds: [runId, "missing"] },
    });
    assert.deepEqual(reply["runs"], [
      { runId, workflowId: "develop" },
      { runId: "missing", workflowId: null },
    ]);
    for (const runIds of [
      [],
      "bad",
      [42],
      [runId, runId],
      Array.from({ length: 501 }, (_, index) => `run-${String(index)}`),
    ]) {
      const invalid = await call(harness, {
        operation: "status",
        parameters: { metadata: "workflows", runIds },
      });
      assert.equal(invalid["code"], "invalid-request");
    }
    await service.close();
  }));

await test("CLV-243 status pages stored ticket identities without run details", () =>
  withHarness(async (harness) => {
    const service = await harness.start({
      workflows: [
        {
          ...harness.registration,
          resolver: {
            ...harness.registration.resolver,
            resolve: (request) =>
              Promise.resolve({
                kind: "resolved",
                input: { ticketId: request.submission["prompt"] },
              }),
          },
        },
      ],
    });
    const expected = [];
    for (const ticketId of ["7", "8"]) {
      const reply = await call(harness, {
        operation: "run",
        parameters: {
          workflowId: "develop",
          source: "prompt",
          submission: { prompt: ticketId },
          commandId: `ticket-${ticketId}`,
        },
      });
      expected.push({ runId: text(reply, "runId"), ticketId });
    }
    expected.sort((left, right) => (left.runId < right.runId ? -1 : 1));
    const first = await call(harness, {
      operation: "status",
      parameters: { metadata: "tickets", limit: 1 },
    });
    assert.deepEqual(first["runs"], expected.slice(0, 1));
    assert.equal(first["next"], expected[0]?.runId);
    const second = await call(harness, {
      operation: "status",
      parameters: { metadata: "tickets", limit: 1, after: first["next"] },
    });
    assert.deepEqual(second["runs"], expected.slice(1));
    assert.equal(second["next"], null);
    await service.close();
  }));

await test("CLV-184 a queue status batch uses terminal event sequences and one run snapshot", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const first = await startedRun(harness, { service, commandId: "first" });
    const second = await startedRun(harness, { service, commandId: "second" });
    assert.equal(
      (
        await service.worker.submit({
          kind: "complete-run",
          commandId: "finished",
          runId: first,
          expectedRevision: 2,
          outcome: "handoff_requested",
        })
      ).kind,
      "accepted",
    );
    const batch = await call(harness, {
      operation: "status",
      parameters: { runIds: [first, second] },
    });
    const runs = items(batch["runs"]);
    assert.deepEqual(
      runs.map((run) => [
        field(run, "runId"),
        field(run, "state"),
        field(run, "terminalSequence"),
      ]),
      [
        [first, "completed", 7],
        [second, "running", null],
      ],
    );
    assert.equal(field(field(runs[0], "outcome"), "kind"), "handoff_requested");
    const missing = await call(harness, {
      operation: "status",
      parameters: { runIds: ["missing"] },
    });
    assert.equal(missing["code"], "unknown-run");
    const malformed = await call(harness, {
      operation: "status",
      parameters: { runIds: "invalid" },
    });
    assert.equal(malformed["code"], "invalid-request");
    await service.close();
  }));

await test("CLV-244 queue status identifies its workflow and current lanes", () =>
  withHarness(async (harness) => {
    const service = await harness.start({
      workflows: [{ ...harness.registration, admission: 2 }],
    });
    try {
      const status = await call(harness, {
        operation: "status",
        parameters: {},
      });
      assert.equal(field(status["queue"], "workflowId"), "develop");
      assert.equal(field(status["queue"], "lanes"), 2);
    } finally {
      await service.close();
    }
  }));

await test("CLV-360 status keeps disabled queues beside enabled queues in workflow order", () =>
  withHarness(async (harness) => {
    const disabled = queueOffPort("a-disabled");
    await harness.start({
      workflows: [
        { ...harness.registration, admission: 2 },
        {
          ...harness.registration,
          workflowId: "a-disabled",
          manifest: { ...harness.registration.manifest, queue: true },
        },
      ],
      queues: new Map([["a-disabled", disabled]]),
    });
    const status = await call(harness, { operation: "status", parameters: {} });
    const queues = items(status["queues"]);
    assert.deepEqual(
      queues.map((queue) => [
        field(queue, "workflowId"),
        field(queue, "state"),
      ]),
      [
        ["a-disabled", "off"],
        ["develop", undefined],
      ],
    );
    assert.deepEqual(status["queue"], queues[0]);
    assert.deepEqual(field(queues[0], "off"), {
      workflowId: "a-disabled",
      source: "queues setting",
    });
  }));

await test("CLV-360 a disabled queue keeps its live runs out of another queue busy count", () =>
  withHarness(async (harness) => {
    const queued = {
      ...harness.registration,
      manifest: { ...harness.registration.manifest, queue: true },
    };
    const service = await harness.start({
      workflows: [
        { ...queued, admission: 2 },
        { ...queued, workflowId: "triage-issue", admission: 1 },
      ],
    });
    const admitted = await call(harness, {
      operation: "run",
      parameters: {
        workflowId: "triage-issue",
        source: "prompt",
        submission: { prompt: "pending" },
        commandId: "disabled-live",
      },
    });
    assert.equal(admitted["kind"], "run-admitted");
    await service.close();
    await harness.start({
      workflows: [
        { ...queued, admission: 2 },
        { ...queued, workflowId: "triage-issue" },
      ],
      queues: new Map([["triage-issue", queueOffPort("triage-issue")]]),
    });
    const status = await call(harness, { operation: "status", parameters: {} });
    assert.deepEqual(
      items(status["queues"]).map((queue) => [
        field(queue, "workflowId"),
        field(queue, "busy"),
      ]),
      [
        ["develop", 0],
        ["triage-issue", 1],
      ],
    );
  }));
