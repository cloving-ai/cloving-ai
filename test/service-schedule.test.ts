import assert from "node:assert/strict";
import { test } from "node:test";
import { send } from "../src/cli/client.ts";
import { withHarness } from "./service-fixture.ts";
import { scheduleConnection } from "../src/daemon/schedule-control.ts";

await test("CLV-242 service refuses schedules until its scheduler port is available", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const reply = await send(harness.runtimeDirectory, {
      operation: "schedule",
      parameters: { action: "list" },
    });
    assert.equal(reply.kind, "error");
    assert.equal(reply.error.code, "schedules-unavailable");
    await service.close();
  }));

await test("CLV-242 service delegates schedule controls after the scheduler connects", () =>
  withHarness(async (harness) => {
    const connection = scheduleConnection();
    const service = await harness.start({ schedule: connection.request });
    const request = {
      operation: "schedule",
      parameters: { action: "pause", workflowId: "review" },
    };
    assert.equal((await send(harness.runtimeDirectory, request)).kind, "error");
    connection.connect((parameters) =>
      Promise.resolve({ kind: "result", result: { parameters } }),
    );
    assert.deepEqual(await send(harness.runtimeDirectory, request), {
      kind: "result",
      result: { parameters: request.parameters },
    });
    await service.close();
  }));
