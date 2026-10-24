import assert from "node:assert/strict";
import { test } from "node:test";
import {
  call,
  field,
  items,
  startedRun,
  withHarness,
} from "./service-fixture.ts";

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
