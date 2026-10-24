import assert from "node:assert/strict";
import { test } from "node:test";
import { handoffWorker } from "../src/daemon/handoff-worker.ts";
import {
  call,
  fakeRegistration,
  withHarness,
  field,
} from "./service-fixture.ts";
import { operationOf } from "./effect-fixture.ts";
import type { Harness } from "./service-fixture.ts";
import { listen } from "../src/service/transport.ts";
import { rejection } from "../src/service/replies.ts";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  located,
  readRecord,
  writeRecord,
} from "../src/daemon/operation-journal.ts";
import { eventually } from "./service-fixture.ts";

function folder(harness: Harness): string {
  return located(settings(harness).journal, intent.operationId).folder;
}

function settings(harness: Harness) {
  return {
    runtimeDirectory: harness.runtimeDirectory,
    journal: harness.stateDirectory + "/handoffs",
    retryMilliseconds: 1,
    document: () => Promise.resolve('{"prompt":"next"}'),
    runStatus: () => Promise.resolve("running"),
  };
}

const intent = {
  kind: "protected-effect" as const,
  purpose: "dispatch" as const,
  runId: "run-source",
  operationId: operationOf("run-source", { round: 1 }),
  workflow: "source-pin",
  inputDigest: `sha256:${"a".repeat(64)}`,
  capability: "handoff",
  method: "run",
  target: "develop",
  payload: `sha256:${"b".repeat(64)}`,
  leaseGeneration: 1,
};

await test("CLV-182 handoff waits a fixed number of times for an active target then starts no run", () =>
  withHarness(async (harness) => {
    const service = await harness.start({
      workflows: [{ ...fakeRegistration([]), admission: "when-idle" }],
    });
    const first = await call(harness, {
      operation: "run",
      parameters: {
        workflowId: "develop",
        commandId: "active",
        source: "input",
        submission: { prompt: "active" },
      },
    });
    const worker = handoffWorker(settings(harness));
    assert.deepEqual(
      await worker.deliver(intent, new AbortController().signal),
      {
        kind: "failed",
        reason: "handoff-start-timeout",
      },
    );
    const reply = await call(harness, { operation: "status", parameters: {} });
    assert.ok(Array.isArray(reply["runs"]));
    assert.equal(reply["runs"].length, 1);
    assert.equal(field(reply["runs"][0], "runId"), first["runId"]);
    await service.close();
  }));

await test("CLV-182 observational reconciliation and stop never start a handoff", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const worker = handoffWorker(settings(harness));
    const signal = new AbortController().signal;
    assert.deepEqual(await worker.reconcile(intent, signal), {
      kind: "absent",
    });
    assert.deepEqual(await worker.stop(intent, signal), { kind: "stopped" });
    const reply = await call(harness, { operation: "status", parameters: {} });
    assert.deepEqual(reply["runs"], []);
    await service.close();
  }));

await test("CLV-182 an authority failure stays uncertain and can recover with the same command", () =>
  withHarness(async (harness) => {
    const listener = await listen({
      path: harness.runtimeDirectory + "/control.sock",
      handle: () =>
        Promise.resolve(
          rejection(
            {
              kind: "failed",
              reason: "storage-failure",
              detail: "interrupted",
            },
            {},
          ),
        ),
    });
    harness.cleanup(listener.close);
    const worker = handoffWorker(settings(harness));
    const signal = new AbortController().signal;
    assert.deepEqual(await worker.deliver(intent, signal), { kind: "unknown" });
    await listener.close();
    const service = await harness.start();
    assert.equal(
      field(await worker.deliver(intent, signal), "kind"),
      "completed",
    );
    await service.close();
  }));

await test("CLV-182 an unconfirmed submission cannot be called stopped from a missing run alone", () =>
  withHarness(async (harness) => {
    const listener = await listen({
      path: harness.runtimeDirectory + "/control.sock",
      handle: (request) =>
        Promise.resolve(
          request.operation === "run"
            ? undefined
            : {
                kind: "error",
                error: {
                  code: "unknown-run",
                  detail: "submission is still pending",
                },
              },
        ),
    });
    harness.cleanup(listener.close);
    const worker = handoffWorker(settings(harness));
    const signal = new AbortController().signal;
    assert.deepEqual(await worker.deliver(intent, signal), { kind: "unknown" });
    assert.deepEqual(await worker.stop(intent, signal), { kind: "unknown" });
    assert.deepEqual(await worker.reconcile(intent, signal), {
      kind: "unknown",
    });
  }));

await test("CLV-182 uncertain recovery replays one command only while the source is running", () =>
  withHarness(async (harness) => {
    const commands: unknown[] = [];
    const listener = await listen({
      path: harness.runtimeDirectory + "/control.sock",
      handle: (request) => {
        if (request.operation === "run")
          commands.push(request.parameters["commandId"]);
        const reply =
          commands.length === 1
            ? undefined
            : {
                kind: "result" as const,
                result: { kind: "run-admitted", runId: "run-target" },
              };
        return Promise.resolve(
          request.operation === "run"
            ? reply
            : {
                kind: "error",
                error: { code: "unknown-run", detail: "not admitted" },
              },
        );
      },
    });
    harness.cleanup(listener.close);
    let status = "running";
    const worker = handoffWorker({
      ...settings(harness),
      runStatus: () => Promise.resolve(status),
    });
    assert.ok(worker.retry);
    const signal = new AbortController().signal;
    assert.deepEqual(await worker.deliver(intent, signal), { kind: "unknown" });
    assert.deepEqual(await worker.reconcile(intent, signal), {
      kind: "unknown",
    });
    for (status of ["paused", "cancelled", "completed", "failed"])
      assert.deepEqual(await worker.retry(intent, signal), {
        kind: "unknown",
      });
    status = "running";
    assert.deepEqual(await worker.retry(intent, AbortSignal.abort()), {
      kind: "unknown",
    });
    assert.equal(commands.length, 1);
    const result = await worker.retry(intent, signal);
    assert.equal(field(result, "kind"), "completed");
    assert.equal(field(result, "result"), "run-target");
    assert.deepEqual(await worker.reconcile(intent, signal), result);
    assert.deepEqual(commands, [
      `handoff:${intent.operationId}`,
      `handoff:${intent.operationId}`,
    ]);
  }));

await test("CLV-182 a lost worker result reuses the committed submission after service restart", () =>
  withHarness(async (harness) => {
    const first = await harness.start();
    const worker = handoffWorker(settings(harness));
    const signal = new AbortController().signal;
    const [one, two] = await Promise.all([
      worker.deliver(intent, signal),
      worker.deliver(intent, signal),
    ]);
    assert.deepEqual(two, one);
    assert.equal(field(one, "kind"), "completed");
    assert.deepEqual(await worker.reconcile(intent, signal), one);
    assert.deepEqual(await worker.stop(intent, signal), one);
    await rm(join(folder(harness), "result.json"));
    await first.close();
    const second = await harness.start();
    const restarted = handoffWorker(settings(harness));
    assert.deepEqual(await restarted.reconcile(intent, signal), one);
    assert.deepEqual(await restarted.deliver(intent, signal), one);
    assert.deepEqual(await restarted.deliver(intent, signal), one);
    assert.equal(harness.resolved.length, 1);
    assert.equal(
      (await call(harness, { operation: "status", parameters: {} }))[
        "runs"
      ] instanceof Array,
      true,
    );
    await second.close();
  }));

await test("CLV-182 a target that becomes idle is retried with one command ID", () =>
  withHarness(async (harness) => {
    const commands: unknown[] = [];
    const listener = await listen({
      path: harness.runtimeDirectory + "/control.sock",
      handle: (request) => {
        commands.push(request.parameters["commandId"]);
        return Promise.resolve(
          commands.length < 3
            ? {
                kind: "error",
                error: { code: "workflow-active", detail: "active" },
              }
            : {
                kind: "result",
                result: { kind: "run-admitted", runId: "run-target" },
              },
        );
      },
    });
    harness.cleanup(listener.close);
    const worker = handoffWorker(settings(harness));
    const result = await worker.deliver(intent, new AbortController().signal);
    assert.deepEqual(result, {
      kind: "completed",
      receipt: "run-target",
      result: "run-target",
      worker: "handoff",
    });
    assert.deepEqual(
      commands,
      Array.from({ length: 3 }, () => `handoff:${intent.operationId}`),
    );
  }));

await test("CLV-182 stopping an active-target wait aborts retries and preserves its count", () =>
  withHarness(async (harness) => {
    const service = await harness.start({
      workflows: [{ ...fakeRegistration([]), admission: "when-idle" }],
    });
    await call(harness, {
      operation: "run",
      parameters: {
        workflowId: "develop",
        commandId: "active",
        source: "input",
        submission: { prompt: "active" },
      },
    });
    const worker = handoffWorker({
      ...settings(harness),
      retryMilliseconds: 1000,
    });
    const signal = new AbortController().signal;
    const pending = worker.deliver(intent, signal);
    await eventually(
      async () =>
        (await readRecord(folder(harness), "attempts.json")) ?? undefined,
    );
    assert.deepEqual(await worker.stop(intent, signal), { kind: "stopped" });
    assert.deepEqual(await pending, { kind: "unknown" });
    assert.deepEqual(await readRecord(folder(harness), "attempts.json"), {
      busy: 1,
    });
    await writeRecord(folder(harness), {
      name: "attempts.json",
      value: { busy: 10 },
    });
    const restarted = handoffWorker(settings(harness));
    assert.deepEqual(await restarted.deliver(intent, signal), {
      kind: "failed",
      reason: "handoff-start-timeout",
    });
    await service.close();
  }));

await test("CLV-182 invalid input, unsupported delivery and cancellation start no submission", () =>
  withHarness(async (harness) => {
    const signal = new AbortController().signal;
    for (const [index, text] of [undefined, "{", "[]"].entries()) {
      const worker = handoffWorker({
        ...settings(harness),
        journal: settings(harness).journal + String(index),
        document: () => Promise.resolve(text),
      });
      const failed = { kind: "failed", reason: "handoff-input-refused" };
      assert.deepEqual(await worker.deliver(intent, signal), failed);
      assert.deepEqual(await worker.reconcile(intent, signal), failed);
    }
    const worker = handoffWorker(settings(harness));
    assert.ok(worker.retry);
    const unsupported = { ...intent, capability: "other" };
    for (const action of [
      worker.deliver,
      worker.reconcile,
      worker.retry,
      worker.stop,
    ])
      assert.deepEqual(await action(unsupported, signal), {
        kind: "failed",
        reason: "unsupported-effect",
      });
    assert.deepEqual(await worker.deliver(intent, AbortSignal.abort()), {
      kind: "unknown",
    });
    assert.deepEqual(await worker.deliver(intent, signal), { kind: "unknown" });
    assert.deepEqual(await worker.retry(intent, signal), { kind: "unknown" });
    assert.deepEqual(await worker.stop(intent, signal), { kind: "unknown" });
  }));

await test("CLV-182 malformed journal state fails closed and a dead submitter proves absence", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const worker = handoffWorker(settings(harness));
    const signal = new AbortController().signal;
    await writeRecord(folder(harness), {
      name: "result.json",
      value: { kind: "invalid" },
    });
    await assert.rejects(
      worker.deliver(intent, signal),
      /invalid-handoff-journal/,
    );
    await rm(join(folder(harness), "result.json"));
    await writeRecord(folder(harness), {
      name: "attempts.json",
      value: { busy: 11 },
    });
    await assert.rejects(
      worker.deliver(intent, signal),
      /invalid-handoff-journal/,
    );
    await rm(join(folder(harness), "attempts.json"));
    await writeRecord(folder(harness), {
      name: "submission.json",
      value: { pending: true, processId: "invalid" },
    });
    await assert.rejects(
      worker.reconcile(intent, signal),
      /invalid-handoff-journal/,
    );
    const child = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    assert.equal(child.status, 0);
    await writeRecord(folder(harness), {
      name: "submission.json",
      value: { pending: true, processId: child.pid },
    });
    assert.deepEqual(await worker.reconcile(intent, signal), {
      kind: "absent",
    });
    await service.close();
  }));
