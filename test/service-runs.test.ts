import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  admitted,
  call,
  field,
  later,
  noon,
  withHarness,
  startedRun,
  waitingGate,
  type Harness,
  fields,
  items,
} from "./service-fixture.ts";
import { command, view } from "./service-views.ts";

function status(
  harness: Harness,
  runId: string,
): Promise<Readonly<Record<string, unknown>>> {
  return call(harness, { operation: "status", parameters: { runId } });
}

const noEffectsAndFeedback = { budget: null, effects: [], feedback: [] };

await test("CLV-008 status gives the state, the revision, the pending decision and the latest sequence of a run as one object", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const waiting = await waitingGate(harness, {
      service,
      commandId: "c-1",
      kind: "question",
    });
    assert.deepEqual(await status(harness, waiting.runId), {
      schemaVersion: 1,
      kind: "run-status",
      run: {
        runId: waiting.runId,
        workflowId: "develop",
        state: "waiting_gate",
        condition: "waiting-decision",
        revision: 3,
        latestSequence: 5,
        pendingDecisions: [waiting.decisionId],
        reason: {
          code: "design-question",
          detail: "A design question waits for an answer.",
        },
        evidence: [],
        lastConfirmedObservation: null,
        recovery: { attempts: 0, limit: null },
        ...noEffectsAndFeedback,
        nextAction: "answer",
        nextActionAt: null,
        humanInputCanHelp: true,
      },
    });
    const second = await admitted(harness, "c-2");
    const list = await call(harness, { operation: "status", parameters: {} });
    const ordered = [waiting.runId, second].sort();
    assert.deepEqual(
      items(field(list, "runs")).map((run: unknown) => [
        field(run, "runId"),
        field(run, "workflowId"),
      ]),
      ordered.map((runId) => [runId, "develop"]),
    );
    assert.equal(field(list, "next"), null);
    const page = await call(harness, {
      operation: "status",
      parameters: { limit: 1 },
    });
    assert.equal(field(page, "next"), ordered[0]);
    const rest = await call(harness, {
      operation: "status",
      parameters: { limit: 1, after: ordered[0] },
    });
    assert.deepEqual(
      items(field(rest, "runs")).map((run: unknown) => field(run, "runId")),
      [ordered[1]],
    );
    const absent = await status(harness, "run-absent");
    assert.equal(field(absent, "code"), "unknown-run");
    await service.close();
  }));

await test("CLV-008 pause and resume return committed receipts and keep the run identity and its work", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const runId = await startedRun(harness, { service, commandId: "c-1" });
    const paused = await command(harness, {
      command: "pause",
      runId,
      expectedRevision: 2,
      commandId: "c-pause",
    });
    assert.deepEqual(
      { ...paused, receipt: null },
      {
        schemaVersion: 1,
        kind: "run-command",
        command: "pause",
        runId,
        commandId: "c-pause",
        replayed: false,
        receipt: null,
        committed: { state: "paused", revision: 3, revokedIntents: 0 },
        observed: { condition: "paused", unresolvedEffects: [] },
      },
    );
    assert.equal(
      field(
        await command(harness, {
          command: "pause",
          runId,
          expectedRevision: 2,
          commandId: "c-pause-2",
        }),
        "code",
      ),
      "stale-revision",
    );
    const resumed = await command(harness, {
      command: "resume",
      runId,
      expectedRevision: 3,
      commandId: "c-resume",
    });
    assert.deepEqual(field(resumed, "committed"), {
      state: "running",
      revision: 4,
      revokedIntents: 0,
    });
    const repeated = await command(harness, {
      command: "resume",
      runId,
      expectedRevision: 3,
      commandId: "c-resume",
    });
    assert.equal(field(repeated, "replayed"), true);
    assert.deepEqual(field(repeated, "receipt"), field(resumed, "receipt"));
    assert.equal(harness.sent.length, 1);
    await service.close();
  }));

await test("CLV-008 a started run with no report in the liveness period shows no-recent-observation, and a report ends that state", () =>
  withHarness(async (harness) => {
    let now = noon;
    const service = await harness.start({ clock: () => now });
    const runId = await startedRun(harness, { service, commandId: "c-1" });
    const reason = async (): Promise<unknown> => {
      const run = await view(harness, runId);
      return [field(run, "condition"), field(field(run, "reason"), "code")];
    };
    assert.deepEqual(await reason(), ["working", "in-progress"]);
    now = "2026-10-11T12:00:00.000Z";
    assert.deepEqual(await reason(), ["working", "no-recent-observation"]);
    await service.worker.observe({
      runId,
      commandId: "c-progress",
      condition: "working",
      reason: "progress",
    });
    assert.deepEqual(await reason(), ["working", "progress"]);
    now = "2026-10-12T12:00:00.000Z";
    assert.deepEqual(await reason(), ["working", "no-recent-observation"]);
    for (const [name, expectedRevision] of [
      ["pause", 2],
      ["resume", 3],
    ] as const)
      await command(harness, {
        command: name,
        runId,
        expectedRevision,
        commandId: `c-${name}`,
      });
    assert.deepEqual(await reason(), ["working", "progress"]);
    await service.close();
  }));

await test("CLV-008 a known quota wait that crosses the liveness bound and a restart stays a quota wait, with no code repair and no new dispatch", () =>
  withHarness(async (harness) => {
    let now = noon;
    const first = await harness.start({ clock: () => now });
    const runId = await startedRun(harness, {
      service: first,
      commandId: "c-1",
    });
    await first.worker.observe({
      runId,
      commandId: "c-quota",
      condition: "quota-wait",
      reason: "provider-quota",
      evidence: "usage-report-1",
      retryAt: later,
    });
    now = "2026-10-11T12:00:00.000Z";
    await first.close();
    const second = await harness.start({ clock: () => now });
    const waiting = await view(harness, runId);
    assert.deepEqual(
      [
        field(waiting, "state"),
        field(waiting, "condition"),
        field(field(waiting, "reason"), "code"),
        field(waiting, "nextAction"),
        field(waiting, "humanInputCanHelp"),
        field(waiting, "evidence"),
      ],
      [
        "running",
        "quota-wait",
        "provider-quota",
        "recheck-eligibility",
        false,
        ["event:4", "usage-report-1"],
      ],
    );
    await delay(300);
    assert.equal(harness.sent.length, 1);
    await second.worker.observe({
      runId,
      commandId: "c-working",
      condition: "working",
      reason: "eligibility-confirmed",
    });
    assert.equal(field(await view(harness, runId), "condition"), "working");
    now = "2026-10-12T12:00:00.000Z";
    const silent = await view(harness, runId);
    assert.deepEqual(
      [field(silent, "condition"), field(field(silent, "reason"), "code")],
      ["working", "no-recent-observation"],
    );
    await second.close();
  }));

const eventKeys = [
  "commandId",
  "payload",
  "recordedAt",
  "runId",
  "schemaVersion",
  "sequence",
  "type",
];

await test("CLV-008 events resume after a given sequence and report an explicit gap for a sequence that the service cannot serve", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const runId = await startedRun(harness, { service, commandId: "c-1" });
    const page = await call(harness, {
      operation: "events",
      parameters: { after: 1, limit: 10 },
    });
    assert.deepEqual(
      items(field(page, "events")).map((event: unknown) => [
        field(event, "sequence"),
        field(event, "type"),
        field(event, "runId"),
        Object.keys(fields(event)).sort(),
      ]),
      [
        [2, "step.dispatched", runId, eventKeys],
        [3, "run.started", runId, eventKeys],
      ],
    );
    assert.deepEqual(
      await call(harness, {
        operation: "events",
        parameters: { after: 9, limit: 10 },
      }),
      {
        kind: "error",
        code: "event-gap",
        detail: "The service has no events after sequence 9.",
        after: 9,
        earliestAvailable: 1,
        latestSequence: 3,
      },
    );
    await service.close();
  }));
