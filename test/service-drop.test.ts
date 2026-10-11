import assert from "node:assert/strict";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  call,
  decide,
  digestOf,
  eventually,
  field,
  items,
  startedRun,
  text,
  withHarness,
  type Harness,
} from "./service-fixture.ts";
import {
  changedManifest,
  command,
  condition,
  continuationOutcomes,
  reasonCode,
  view,
} from "./service-views.ts";

function startOperation(runId: string): string {
  return `["cloving-operation",0,"${runId}","admission","start-run",null,null]`;
}

async function uncertainStart(harness: Harness): Promise<string> {
  const result = await call(harness, {
    operation: "run",
    parameters: {
      workflowId: "develop",
      source: "prompt",
      submission: { prompt: "task" },
      commandId: "c-1",
    },
  });
  const runId = text(result, "runId");
  await eventually(async () =>
    (await condition(harness, runId)) === "uncertain-effect" ? true : undefined,
  );
  return runId;
}

await test("CLV-008 a dropped run with a start of unknown result never starts afterward, and its status claims no terminal cancellation", () =>
  withHarness(async (harness) => {
    const failing = await harness.start({
      delivery: {
        reconcile: () => Promise.reject(new Error("destination unreachable")),
        deliver: () => Promise.reject(new Error("destination unreachable")),
      },
    });
    const runId = await uncertainStart(harness);
    const dropped = await command(harness, {
      command: "drop",
      runId,
      expectedRevision: 1,
      commandId: "c-drop",
    });
    assert.deepEqual(field(dropped, "committed"), {
      state: "cancelled",
      revision: 2,
      revokedIntents: 1,
    });
    assert.deepEqual(field(dropped, "observed"), {
      condition: "cancelling",
      unresolvedEffects: [startOperation(runId)],
    });
    await failing.close();
    const healthy = await harness.start();
    await delay(400);
    assert.deepEqual(harness.sent, []);
    const after = await view(harness, runId);
    assert.deepEqual(
      [
        field(after, "state"),
        field(after, "condition"),
        field(field(after, "reason"), "code"),
        field(after, "nextAction"),
      ],
      [
        "cancelled",
        "cancelling",
        "delivery-outcome-unknown",
        "reconcile-effect",
      ],
    );
    assert.equal(
      field(
        await command(harness, {
          command: "resume",
          runId,
          expectedRevision: 2,
          commandId: "c-resume",
        }),
        "code",
      ),
      "terminal-run",
    );
    await healthy.close();
  }));

await test("CLV-008 the receipt of a repeated drop has no unresolved effect after a stop report that names the operation", () =>
  withHarness(async (harness) => {
    const service = await harness.start({
      delivery: {
        reconcile: () => Promise.reject(new Error("destination unreachable")),
        deliver: () => Promise.reject(new Error("destination unreachable")),
      },
    });
    const runId = await uncertainStart(harness);
    const drop = {
      command: "drop",
      runId,
      expectedRevision: 1,
      commandId: "c-drop",
    };
    assert.deepEqual(field(await command(harness, drop), "observed"), {
      condition: "cancelling",
      unresolvedEffects: [startOperation(runId)],
    });
    await service.worker.observe({
      runId,
      commandId: "c-stopped",
      condition: "stopped",
      reason: "worker-exit",
      operationId: startOperation(runId),
    });
    const repeated = await command(harness, drop);
    assert.deepEqual(
      [field(repeated, "replayed"), field(repeated, "observed")],
      [true, { condition: "cancelled", unresolvedEffects: [] }],
    );
    await service.close();
  }));

await test("CLV-008 a drop receipt separates the committed intent from the observed stop, and a lost stop reply claims no terminal cancellation", () =>
  withHarness(async (harness) => {
    const first = await harness.start();
    const runId = await startedRun(harness, {
      service: first,
      commandId: "c-1",
    });
    const dropped = await command(harness, {
      command: "drop",
      runId,
      expectedRevision: 2,
      commandId: "c-drop",
    });
    assert.deepEqual(
      [field(dropped, "committed"), field(dropped, "observed")],
      [
        { state: "cancelled", revision: 3, revokedIntents: 0 },
        { condition: "cancelling", unresolvedEffects: [] },
      ],
    );
    await first.close();
    const second = await harness.start();
    const pending = await view(harness, runId);
    assert.deepEqual(
      [
        field(pending, "state"),
        field(pending, "condition"),
        field(field(pending, "reason"), "code"),
        field(pending, "nextAction"),
      ],
      ["cancelled", "cancelling", "stop-not-observed", "observe-worker-stop"],
    );
    await delay(300);
    assert.equal(harness.sent.length, 1);
    const list = await call(harness, { operation: "status", parameters: {} });
    assert.equal(items(field(list, "runs")).length, 1);
    const stopped = { runId, condition: "stopped", reason: "worker-exit" };
    await second.worker.observe({ ...stopped, commandId: "c-stopped-unnamed" });
    assert.equal(await condition(harness, runId), "cancelling");
    await second.worker.observe({
      ...stopped,
      commandId: "c-stopped",
      operationId: startOperation(runId),
    });
    assert.equal(await condition(harness, runId), "cancelled");
    await second.close();
  }));

await test("CLV-008 drop deletes no file of the state directory or the workspace, and the same run is present after a restart", () =>
  withHarness(async (harness) => {
    const first = await harness.start();
    const runId = await startedRun(harness, {
      service: first,
      commandId: "c-1",
    });
    await writeFile(join(harness.projectDirectory, "work.txt"), "evidence\n");
    const before = await readdir(harness.stateDirectory);
    await command(harness, {
      command: "drop",
      runId,
      expectedRevision: 2,
      commandId: "c-drop",
    });
    const names = await readdir(harness.stateDirectory);
    assert.deepEqual(
      before.filter((name) => !names.includes(name)),
      [],
    );
    await first.close();
    assert.ok(
      (await readdir(harness.stateDirectory)).includes("authority.sqlite"),
    );
    assert.deepEqual(await readdir(harness.projectDirectory), ["work.txt"]);
    const second = await harness.start();
    assert.equal(field(await view(harness, runId), "runId"), runId);
    await second.close();
  }));

async function earlyAnswer(harness: Harness): Promise<string> {
  const first = await harness.start();
  const runId = await startedRun(harness, { service: first, commandId: "c-1" });
  await first.worker.openGate({
    runId,
    commandId: "c-1-open",
    expectedRevision: 2,
    gateId: "design-1",
    kind: "question",
    prompt: "which?",
    subject: digestOf("which?"),
  });
  const answered = await decide(harness, {
    command: "answer",
    reference: `${runId}/design-1`,
    text: "blue",
    subjectDigest: digestOf("which?"),
  });
  assert.equal(field(answered, "continuation"), "held");
  await first.close();
  return runId;
}

await test("CLV-008 a dropped run with a continuation that was never sent has no unresolved effect and never sends it", () =>
  withHarness(async (harness) => {
    const runId = await earlyAnswer(harness);
    const changed = await harness.start({
      workflows: [{ ...harness.registration, manifest: changedManifest }],
    });
    await changed.worker.registerWait({
      runId,
      commandId: "c-1-wait",
      gateId: "design-1",
    });
    await eventually(async () =>
      (await reasonCode(harness, runId)) === "pinned-workflow-unavailable"
        ? true
        : undefined,
    );
    const dropped = await call(harness, {
      operation: "run-command",
      parameters: {
        command: "drop",
        runId,
        expectedRevision: 4,
        commandId: "c-drop",
      },
    });
    assert.deepEqual(
      [field(dropped, "committed"), field(dropped, "observed")],
      [
        { state: "cancelled", revision: 5, revokedIntents: 1 },
        { condition: "cancelling", unresolvedEffects: [] },
      ],
    );
    await changed.worker.observe({
      runId,
      commandId: "c-stopped",
      condition: "stopped",
      reason: "worker-exit",
      operationId: startOperation(runId),
    });
    assert.equal(await condition(harness, runId), "cancelled");
    await changed.close();
    assert.deepEqual(continuationOutcomes(harness), ["blocked"]);
    const original = await harness.start();
    await delay(300);
    assert.deepEqual(
      harness.sent.map((intent) => intent.kind),
      ["start-run"],
    );
    await original.close();
  }));

await test("CLV-008 a drop while a dispatch is in flight reports the unresolved effect and stays cancelling until the dispatch settles", () =>
  withHarness(async (harness) => {
    const release = Promise.withResolvers<undefined>();
    harness.cleanup(() => {
      release.resolve(undefined);
    });
    const service = await harness.start({
      delivery: {
        reconcile: () => Promise.resolve({ kind: "absent" }),
        deliver: async (intent) => {
          await release.promise;
          harness.sent.push(intent);
          return { receipt: "wrun-1" };
        },
      },
    });
    const admitted = await call(harness, {
      operation: "run",
      parameters: {
        workflowId: "develop",
        source: "prompt",
        submission: { prompt: "task" },
        commandId: "c-1",
      },
    });
    const runId = text(admitted, "runId");
    await eventually(async () =>
      (await reasonCode(harness, runId)) === "dispatch-in-progress"
        ? true
        : undefined,
    );
    const dropped = await call(harness, {
      operation: "run-command",
      parameters: {
        command: "drop",
        runId,
        expectedRevision: 1,
        commandId: "c-drop",
      },
    });
    assert.deepEqual(field(dropped, "observed"), {
      condition: "cancelling",
      unresolvedEffects: [startOperation(runId)],
    });
    release.resolve(undefined);
    await eventually(async () =>
      (await condition(harness, runId)) === "cancelling" &&
      harness.sent.length === 1
        ? true
        : undefined,
    );
    await service.close();
  }));
