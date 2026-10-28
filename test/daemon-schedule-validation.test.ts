import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { startDaemon } from "../src/daemon/daemon.ts";
import { scheduledDeclarations } from "../src/daemon/workflow-schedules.ts";
import { withFiles } from "./quality/files-fixture.ts";
import { serviceLimits } from "../src/service/service.ts";

await test("CLV-179 prototype-named workflow IDs remain unscheduled without a declaration or setting", () => {
  for (const workflowId of ["toString", "constructor", "hasOwnProperty"]) {
    const declaration = {
      workflowId,
      functionName: "review",
      effectLimit: 1,
      capabilities: ["claude" as const],
      input: { maximumBytes: 100, fields: {} },
    };
    assert.deepEqual(scheduledDeclarations({ declarations: [declaration] }), {
      kind: "configured",
      declarations: [declaration],
    });
  }
});

await test("CLV-179 invalid schedules refuse startup before any state or host is created", async () => {
  for (const [schedules, code] of [
    [null, "invalid-schedules"],
    [[], "invalid-schedules"],
    [
      { missing: { everySeconds: 300, input: {} } },
      "unknown-schedule-workflow",
    ],
    [{ review: { everySeconds: 59, input: {} } }, "invalid-schedule-interval"],
    [
      { review: { everySeconds: 300, input: { extra: true } } },
      "invalid-schedule-input",
    ],
  ] as const)
    await withFiles({}, async (directory) => {
      const opening = await startDaemon({
        directory,
        runtimeDirectory: join(directory, "run"),
        repository: directory,
        schedules,
        declarations: [
          {
            workflowId: "review",
            functionName: "review",
            effectLimit: 1,
            capabilities: ["claude"],
            input: { maximumBytes: 100, fields: {} },
          },
        ],
        manifests: {},
        workflows: {},
        handler: () => Promise.resolve(new Response()),
        command: ["false"],
        concurrency: 1,
      });
      assert.deepEqual(opening, {
        kind: "refused",
        reason: "schedule-rejected",
        detail: `Error: ${code}`,
      });
      assert.equal(existsSync(join(directory, "state")), false);
      assert.equal(existsSync(join(directory, "run")), false);
    });
});

await test("CLV-179 schedules must fit the service document limit including the declared input envelope", async () => {
  for (const size of [
    serviceLimits.documentBytes + 1,
    serviceLimits.documentBytes - 20,
  ])
    await withFiles({}, async (directory) => {
      const input = { prompt: "x".repeat(size) };
      assert.equal(
        Buffer.byteLength(JSON.stringify(input)) <= serviceLimits.documentBytes,
        size < serviceLimits.documentBytes,
      );
      const opening = await startDaemon({
        directory,
        runtimeDirectory: join(directory, "run"),
        repository: directory,
        declarations: [
          {
            workflowId: "review",
            functionName: "review",
            effectLimit: 1,
            capabilities: ["claude"],
            input: {
              maximumBytes: 524288,
              fields: { prompt: { type: "string" } },
            },
            schedule: {
              everySeconds: 300,
              input,
            },
          },
        ],
        manifests: {},
        workflows: {},
        handler: () => Promise.resolve(new Response()),
        command: ["false"],
        concurrency: 1,
      });
      assert.deepEqual(opening, {
        kind: "refused",
        reason: "schedule-rejected",
        detail: "Error: invalid-schedule-input",
      });
      assert.equal(existsSync(join(directory, "state")), false);
    });
});
