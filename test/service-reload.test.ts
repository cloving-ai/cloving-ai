import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkflowRegistration } from "../src/service/service.ts";
import type { WorkflowReload } from "../src/service/workflow-reload.ts";
import { manifest } from "./authority-store-fixture.ts";
import {
  admitted,
  call,
  fakeRegistration,
  field,
  withHarness,
  type Harness,
} from "./service-fixture.ts";

const startDigest = "a".repeat(64);
const reloadDigest = "b".repeat(64);
const noFields = { reloadedFields: [], restartFields: [] };

function registration(workflowId: string): WorkflowRegistration {
  return {
    ...fakeRegistration([]),
    workflowId,
    manifest: {
      ...manifest,
      name: workflowId,
      workflowId: `workflow//./workflows/${workflowId}//${workflowId}`,
    },
  };
}

async function revision(harness: Harness, runId: string): Promise<unknown> {
  const status = await call(harness, {
    operation: "status",
    parameters: { runId },
  });
  return field(status["run"], "revision");
}

await test("CLV-252 reload prints the reload reply, and status shows the new workflows and bundle digest", () =>
  withHarness(async (harness) => {
    const outcomes: WorkflowReload[] = [
      {
        kind: "reloaded",
        bundleDigest: reloadDigest,
        workflows: [registration("develop"), registration("triage")],
        workflowRefusals: [],
        ...noFields,
      },
      {
        kind: "unchanged",
        workflowRefusals: [
          { scope: "project", label: "broken.ts", codes: ["compile-failed"] },
        ],
        ...noFields,
      },
    ];
    await harness.start({
      bundleDigest: startDigest,
      reload: () => {
        const outcome = outcomes.shift();
        assert.ok(outcome);
        return Promise.resolve(outcome);
      },
    });
    const reloaded = await harness.cli(["reload", "--json"]);
    assert.equal(reloaded.status, 0, reloaded.stdout + reloaded.stderr);
    assert.deepEqual(JSON.parse(reloaded.stdout), {
      schemaVersion: 1,
      kind: "reload",
      status: "reloaded",
      previousBundleDigest: startDigest,
      bundleDigest: reloadDigest,
      workflows: ["develop", "triage"],
      workflowRefusals: [],
      ...noFields,
    });
    const status = await call(harness, { operation: "status", parameters: {} });
    assert.deepEqual(status["workflows"], ["develop", "triage"]);
    assert.equal(status["bundleDigest"], reloadDigest);
    const unchanged = await harness.cli(["reload"]);
    assert.equal(unchanged.status, 0, unchanged.stdout + unchanged.stderr);
    assert.equal(
      unchanged.stdout,
      [
        "Reload: unchanged",
        `Bundle digest: ${reloadDigest} -> ${reloadDigest}`,
        "Workflows: develop, triage",
        "Refused workflows:",
        "  project broken.ts: compile-failed",
        "",
      ].join("\n"),
    );
    const after = await call(harness, { operation: "status", parameters: {} });
    assert.deepEqual(after["workflowRefusals"], [
      { scope: "project", label: "broken.ts", codes: ["compile-failed"] },
    ]);
    assert.equal(after["bundleDigest"], reloadDigest);
  }));

await test("CLV-253 reload shows the reloaded fields and the fields that need a restart", () =>
  withHarness(async (harness) => {
    const outcome: WorkflowReload = {
      kind: "unchanged",
      workflowRefusals: [],
      reloadedFields: ["fallbackModels", "profiles"],
      restartFields: ["notify.command", "queue.lanes"],
    };
    await harness.start({
      bundleDigest: startDigest,
      reload: () => Promise.resolve(outcome),
    });
    const reply = await harness.cli(["reload", "--json"]);
    assert.equal(reply.status, 0, reply.stdout + reply.stderr);
    assert.deepEqual(JSON.parse(reply.stdout), {
      schemaVersion: 1,
      kind: "reload",
      status: "unchanged",
      previousBundleDigest: startDigest,
      bundleDigest: startDigest,
      workflows: ["develop"],
      workflowRefusals: [],
      reloadedFields: ["fallbackModels", "profiles"],
      restartFields: ["notify.command", "queue.lanes"],
    });
    const text = await harness.cli(["reload"]);
    assert.equal(text.status, 0, text.stdout + text.stderr);
    assert.equal(
      text.stdout,
      [
        "Reload: unchanged",
        `Bundle digest: ${startDigest} -> ${startDigest}`,
        "Workflows: develop",
        "Reloaded fields: fallbackModels, profiles",
        "Fields that need a restart: notify.command, queue.lanes",
        "",
      ].join("\n"),
    );
  }));

await test("CLV-252 a service with no reload port replies reload-unavailable", () =>
  withHarness(async (harness) => {
    await harness.start();
    const reply = await call(harness, { operation: "reload", parameters: {} });
    assert.equal(reply["code"], "reload-unavailable", JSON.stringify(reply));
  }));

await test("CLV-252 a second reload during a reload gets reload-in-progress, and a refusal changes nothing", () =>
  withHarness(async (harness) => {
    const entered = Promise.withResolvers<undefined>();
    const refusal = Promise.withResolvers<WorkflowReload>();
    await harness.start({
      bundleDigest: startDigest,
      reload: () => {
        entered.resolve(undefined);
        return refusal.promise;
      },
    });
    const first = harness.cli(["reload", "--json"]);
    await entered.promise;
    const second = await call(harness, {
      operation: "reload",
      parameters: {},
    });
    assert.equal(second["code"], "reload-in-progress", JSON.stringify(second));
    refusal.resolve({
      kind: "refused",
      code: "reload-needs-restart",
      detail: "The queue workflow changed.",
    });
    const refused = await first;
    assert.equal(refused.status, 1, refused.stdout + refused.stderr);
    const error: unknown = JSON.parse(refused.stdout);
    assert.equal(field(error, "code"), "reload-needs-restart");
    const status = await call(harness, { operation: "status", parameters: {} });
    assert.deepEqual(status["workflows"], ["develop"]);
    assert.equal(status["bundleDigest"], startDigest);
  }));

await test("CLV-252 after a reload a removed workflow is unknown, and a run of it keeps its pin", () =>
  withHarness(async (harness) => {
    await harness.start({
      reload: () =>
        Promise.resolve({
          kind: "reloaded",
          bundleDigest: reloadDigest,
          workflows: [registration("triage")],
          workflowRefusals: [],
          ...noFields,
        }),
    });
    const runId = await admitted(harness, "before-reload");
    const paused = await call(harness, {
      operation: "run-command",
      parameters: {
        command: "pause",
        runId,
        expectedRevision: await revision(harness, runId),
        commandId: "pause-before-reload",
      },
    });
    assert.equal(paused["kind"], "run-command", JSON.stringify(paused));
    const reload = await call(harness, { operation: "reload", parameters: {} });
    assert.deepEqual(reload["workflows"], ["triage"]);
    assert.equal(reload["previousBundleDigest"], null);
    const removed = await call(harness, {
      operation: "run",
      parameters: {
        workflowId: "develop",
        source: "prompt",
        submission: { prompt: "after the reload" },
        commandId: "removed-workflow",
      },
    });
    assert.equal(removed["code"], "unknown-workflow", JSON.stringify(removed));
    const resumed = await call(harness, {
      operation: "run-command",
      parameters: {
        command: "resume",
        runId,
        expectedRevision: await revision(harness, runId),
        commandId: "resume-after-reload",
      },
    });
    assert.equal(resumed["kind"], "run-command", JSON.stringify(resumed));
    assert.equal(
      (await admitted(harness, {
        commandId: "new-triage",
        workflowId: "triage",
      })) !== "",
      true,
    );
  }));
