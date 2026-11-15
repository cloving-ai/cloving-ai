import assert from "node:assert/strict";
import { test } from "node:test";
import { call, withHarness, type Harness } from "./service-fixture.ts";
import type { QueueSettingRequest } from "../src/queue-setting-operation.ts";
import type { QueueLaneChange, QueuePort } from "../src/queue-state.ts";

const request: QueueSettingRequest = {
  commandId: "edit-alpha",
  scope: "workflow",
  workflowId: "alpha",
  action: "set",
  field: "lanes",
  value: 3,
  expectedValue: 4,
};

function workflow(harness: Harness, workflowId: string) {
  return {
    ...harness.registration,
    workflowId,
    admission: 4,
    manifest: { ...harness.registration.manifest, queue: true },
  };
}

function port(limits: { lanes: number }) {
  return {
    control: () => ({
      failedRunIds: [],
      drain: undefined,
      error: undefined,
      lanes: limits.lanes,
      settings: {
        lanes: { value: limits.lanes, source: "declaration" as const },
        workingLanes: { value: limits.lanes, source: "default" as const },
        everySeconds: { value: 120, source: "default" as const },
      },
    }),
    change: () => Promise.resolve({ kind: "changed" as const }),
  };
}

function outcomeChange(outcome: QueueLaneChange | Error) {
  return () =>
    outcome instanceof Error
      ? Promise.reject(outcome)
      : Promise.resolve(outcome);
}

await test("CLV-377 typed setting refusals and lost-reply replay return scoped actionable feedback without leaking internal failures", async () => {
  const cases: readonly (readonly [QueueLaneChange | Error, string])[] = [
    [
      { kind: "unavailable", detail: "Fix the reload and retry." },
      "queue-setting-failed",
    ],
    [
      { kind: "unavailable", detail: "Saved but not applied.", saved: true },
      "queue-setting-failed",
    ],
    [{ kind: "conflicting-command" }, "conflicting-command"],
    [{ kind: "stale" }, "queue-setting-changed"],
    [{ kind: "replayed" }, "queue-setting"],
    [
      new Error("queue-lanes-apply: Fix the controlling setting."),
      "queue-setting-failed",
    ],
    [new Error("sensitive internal failure"), "queue-setting-failed"],
  ];
  for (const [outcome, code] of cases)
    await withHarness(async (harness) => {
      await harness.start({
        workflows: [workflow(harness, "alpha")],
        queues: new Map([["alpha", port({ lanes: 4 })]]),
        queueSettings: { change: outcomeChange(outcome) },
      });
      const reply = await call(harness, {
        operation: "queue-setting",
        parameters: { ...request, value: 4 },
      });
      assert.equal(reply["code"] ?? reply["kind"], code, JSON.stringify(reply));
      assert.equal(
        reply["saved"],
        Reflect.get(outcome, "saved"),
        JSON.stringify(reply),
      );
      assert.doesNotMatch(JSON.stringify(reply), /sensitive internal failure/);
    });
});

await test("CLV-377 absent, off and read-only queue settings remain ineligible for a global mutation", async () => {
  const regular = port({ lanes: 4 });
  const off: QueuePort = {
    ...regular,
    control: () => ({
      ...regular.control(),
      off: { workflowId: "alpha", source: "queues setting" },
    }),
  };
  for (const queue of [undefined, off, regular])
    await withHarness(async (harness) => {
      let writes = 0;
      const change = () => {
        writes++;
        return Promise.resolve({ kind: "changed" as const });
      };
      await harness.start({
        workflows: [workflow(harness, "alpha")],
        queues: new Map(queue === undefined ? [] : [["alpha", queue]]),
        queueSettings: queue === regular ? {} : { change },
      });
      const reply = await call(harness, {
        operation: "queue-setting",
        parameters: {
          commandId: "global",
          scope: "global",
          field: "lanes",
          action: "set",
          expectedValue: 16,
          value: 2,
        },
      });
      assert.equal(reply["code"], "queue-unavailable");
      assert.equal(writes, 0);
    });
});

await test("CLV-377 a missing reload port returns the existing unavailable reply to the typed writer", () =>
  withHarness(async (harness) => {
    let reloadReply: unknown;
    await harness.start({
      workflows: [workflow(harness, "alpha")],
      queues: new Map([["alpha", port({ lanes: 4 })]]),
      queueSettings: {
        change: async (_request, reload) => {
          reloadReply = await reload();
          return {
            kind: "unavailable",
            detail: "Reload is unavailable. Reconnect and retry.",
          };
        },
      },
    });
    const reply = await call(harness, {
      operation: "queue-setting",
      parameters: { ...request },
    });
    assert.match(JSON.stringify(reloadReply), /reload-unavailable/);
    assert.equal(reply["code"], "queue-setting-failed");
  }));

await test("CLV-377 typed queue setting actions validate eligibility before changing settings or reloading", () =>
  withHarness(async (harness) => {
    const alpha = { lanes: 4 };
    const beta = { lanes: 4 };
    const calls: QueueSettingRequest[] = [];
    let reloads = 0;
    await harness.start({
      workflows: [
        workflow(harness, "alpha"),
        workflow(harness, "beta"),
        { ...harness.registration, workflowId: "manual" },
      ],
      queues: new Map([
        ["alpha", port(alpha)],
        ["beta", port(beta)],
      ]),
      reload: () => {
        reloads += 1;
        return Promise.resolve({
          kind: "unchanged",
          workflowRefusals: [],
          reloadedFields: [],
          restartFields: [],
        });
      },
      queueSettings: {
        change: async (given, reload) => {
          calls.push(given);
          alpha.lanes = given.value ?? 4;
          await reload();
          return { kind: "changed" };
        },
      },
    });
    await refusedRequests(harness);
    assert.equal(calls.length, 0);
    assert.equal(reloads, 0);
    const changed = await call(harness, {
      operation: "queue-setting",
      parameters: { ...request },
    });
    assert.equal(changed["kind"], "queue-setting", JSON.stringify(changed));
    assert.equal(alpha.lanes, 3);
    assert.equal(beta.lanes, 4);
    assert.equal(reloads, 1);
    assert.deepEqual(calls, [request]);
  }));

async function refusedRequests(harness: Harness) {
  for (const workflowId of ["unknown", "manual"]) {
    const refused = await call(harness, {
      operation: "queue-setting",
      parameters: { ...request, workflowId },
    });
    assert.equal(refused["code"], "queue-unavailable");
  }
  for (const patch of [
    { value: 0 },
    { field: "queue.globalLanes" },
    { path: "config.json" },
  ]) {
    const refused = await call(harness, {
      operation: "queue-setting",
      parameters: { ...request, ...patch },
    });
    assert.equal(refused["code"], "invalid-request");
  }
}
