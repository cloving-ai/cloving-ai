import assert from "node:assert/strict";
import { test } from "node:test";
import { fullReads, preparedDuring } from "./authority-memory-fixture.ts";
import { call, startedRun, withHarness } from "./service-fixture.ts";

await test("CLV-276 a status request after the start reads no projected table in full", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const runId = await startedRun(harness, { service, commandId: "c-1" });
    await call(harness, { operation: "status", parameters: {} });
    const statements = await preparedDuring(async () => {
      await call(harness, { operation: "status", parameters: {} });
      await call(harness, { operation: "status", parameters: { runId } });
    });
    assert.deepEqual(fullReads(statements), []);
  }));
