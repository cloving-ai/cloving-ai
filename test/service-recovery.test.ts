import assert from "node:assert/strict";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type {
  Delivery,
  DeliveryIntent,
} from "../src/broker/actor/authority.ts";
import { startService } from "../src/service/service.ts";
import {
  call,
  decide,
  digestOf,
  eventually,
  field,
  withHarness,
  startedRun,
  text,
  waitingGate,
  type Harness,
} from "./service-fixture.ts";
import {
  changedManifest,
  condition,
  continuationOutcomes,
} from "./service-views.ts";

function unreachableContinuations(sent: DeliveryIntent[]): Delivery {
  return {
    reconcile: (intent) =>
      intent.kind === "continue-run"
        ? Promise.reject(new Error("destination unreachable"))
        : Promise.resolve({ kind: "absent" }),
    deliver: (intent) => {
      sent.push(intent);
      return Promise.resolve({ receipt: `wrun-${String(sent.length)}` });
    },
  };
}

async function failedContinuation(harness: Harness): Promise<string> {
  const first = await harness.start({
    delivery: unreachableContinuations(harness.sent),
  });
  const waiting = await waitingGate(harness, {
    service: first,
    commandId: "c-1",
    kind: "approval",
  });
  const approved = await decide(harness, {
    command: "approve",
    reference: waiting.decisionId,
    subjectDigest: digestOf("approval of c-1?"),
  });
  assert.equal(field(approved, "continuation"), "admitted");
  await eventually(async () =>
    (await condition(harness, waiting.runId)) === "uncertain-effect"
      ? true
      : undefined,
  );
  await first.close();
  return waiting.runId;
}

async function blockedView(
  harness: Harness,
  runId: string,
): Promise<readonly unknown[]> {
  const status = await call(harness, {
    operation: "status",
    parameters: { runId },
  });
  const run = field(status, "run");
  return [
    text(run, "workflowId").startsWith("sha256:"),
    field(run, "condition"),
    field(field(run, "reason"), "code"),
    field(run, "nextAction"),
    field(run, "humanInputCanHelp"),
  ];
}

await test("CLV-008 the delivery does not send a continuation whose available manifest differs from the stored pin", () =>
  withHarness(async (harness) => {
    const runId = await failedContinuation(harness);
    const changed = await harness.start({
      workflows: [{ ...harness.registration, manifest: changedManifest }],
    });
    await delay(400);
    assert.deepEqual(
      harness.sent.map((intent) => intent.kind),
      ["start-run"],
    );
    assert.deepEqual(await blockedView(harness, runId), [
      true,
      "infrastructure-failure",
      "pinned-workflow-unavailable",
      "restore-pinned-workflow",
      true,
    ]);
    for (const report of ["c-report-1", "c-report-2", "c-report-3"])
      await changed.worker.observe({
        runId,
        commandId: report,
        condition: "working",
        reason: "progress",
      });
    await delay(200);
    await changed.close();
    assert.deepEqual(continuationOutcomes(harness), ["failed", "blocked"]);
    const original = await harness.start();
    await eventually(() => (harness.sent.length === 2 ? true : undefined));
    await delay(300);
    assert.deepEqual(
      harness.sent.map((intent) => [intent.kind, intent.decision]),
      [
        ["start-run", undefined],
        ["continue-run", "approved"],
      ],
    );
    await original.close();
    assert.deepEqual(continuationOutcomes(harness), [
      "failed",
      "blocked",
      "sent",
    ]);
  }));

await test("CLV-008 a worker result ends the run, and the status gives the terminal outcome", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const done = await startedRun(harness, { service, commandId: "c-1" });
    await service.worker.completed({
      runId: done,
      commandId: "c-1-completed",
      expectedRevision: 2,
    });
    assert.equal(await condition(harness, done), "completed");
    const broken = await startedRun(harness, { service, commandId: "c-2" });
    await service.worker.observe({
      runId: broken,
      commandId: "c-2-observed",
      condition: "code-failure",
      reason: "tests-failed",
      attempt: 3,
      limit: 3,
    });
    await service.worker.failed({
      runId: broken,
      commandId: "c-2-failed",
      expectedRevision: 2,
    });
    const status = await call(harness, {
      operation: "status",
      parameters: { runId: broken },
    });
    assert.deepEqual(
      [
        field(field(status, "run"), "condition"),
        field(field(field(status, "run"), "reason"), "code"),
        field(field(status, "run"), "recovery"),
      ],
      ["failed", "tests-failed", { attempts: 3, limit: 3 }],
    );
    await service.close();
  }));

const dropCommand = {
  command: "drop",
  runId: "run-1",
  expectedRevision: 1,
  commandId: "c-1",
};

const invalidRequests = [
  [{ operation: "status", parameters: { limit: 0 } }, "invalid-request"],
  [{ operation: "status", parameters: { after: 5 } }, "invalid-request"],
  [{ operation: "status", parameters: { runId: 5 } }, "unknown-run"],
  [
    {
      operation: "run-command",
      parameters: { ...dropCommand, command: "stop" },
    },
    "invalid-request",
  ],
  [{ operation: "run-command", parameters: dropCommand }, "unknown-run"],
  [{ operation: "events", parameters: { after: -1 } }, "invalid-request"],
  [
    {
      operation: "run",
      parameters: {
        workflowId: "develop",
        source: "prompt",
        submission: { prompt: "work on CLV-001" },
        commandId: "c-1",
      },
    },
    "ticket-already-complete",
  ],
] as const;

await test("CLV-008 an invalid request and a rejected resolution change no state", () =>
  withHarness(async (harness) => {
    const service = await harness.start({
      workflows: [
        {
          ...harness.registration,
          resolver: {
            id: "closed-resolver",
            version: "1",
            resolve: () =>
              Promise.resolve({
                kind: "rejected",
                code: "ticket-already-complete",
                detail: "The ticket is complete.",
              }),
          },
        },
      ],
    });
    const replies: Readonly<Record<string, unknown>>[] = [];
    for (const [request, code] of invalidRequests) {
      const reply = await call(harness, request);
      assert.equal(field(reply, "code"), code, JSON.stringify(request));
      replies.push(reply);
    }
    assert.equal(field(replies[4], "currentRevision"), null);
    const events = await call(harness, {
      operation: "events",
      parameters: { after: 0 },
    });
    assert.deepEqual(field(events, "events"), []);
    await service.close();
  }));

await test("CLV-008 the service refuses a runtime directory that does not exist and a socket path that it cannot use, and starts with its default timing", () =>
  withHarness(async (harness) => {
    const options = { delivery: unreachableContinuations([]) };
    assert.deepEqual(
      await harness.attempt({
        ...options,
        runtimeDirectory: join(harness.runtimeDirectory, "absent"),
      }),
      {
        kind: "refused",
        reason: "insecure-runtime-directory",
        detail: "not a directory",
      },
    );
    await mkdir(join(harness.runtimeDirectory, "control.sock"));
    const blocked = await harness.attempt(options);
    assert.equal(blocked.kind, "refused");
    assert.equal(Reflect.get(blocked, "reason"), "transport-failure");
    await rm(join(harness.runtimeDirectory, "control.sock"), {
      recursive: true,
    });
    const opened = harness.track(
      await startService({
        ...options,
        stateDirectory: harness.stateDirectory,
        runtimeDirectory: harness.runtimeDirectory,
        workflows: [harness.registration],
      }),
    );
    assert.equal(opened.kind, "started");
    const status = await call(harness, { operation: "status", parameters: {} });
    assert.equal(field(status, "kind"), "run-list");
    await opened.service.close();
    assert.deepEqual(await readdir(harness.runtimeDirectory), []);
  }));
