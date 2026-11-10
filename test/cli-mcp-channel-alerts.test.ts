import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { testMilliseconds } from "./test-timing.ts";
import type { Fields } from "../src/protocol.ts";
import { fields, withHarness } from "./service-fixture.ts";
import {
  approval,
  approvalRun,
  channelServer,
  channelService,
} from "./mcp-channel-fixture.ts";

await test("CLV-338 a new pending decision gives exactly one channel message with content and meta", () =>
  withHarness(async (harness) => {
    const service = await channelService(harness.runtimeDirectory);
    harness.cleanup(() => service.close());
    service.run(approvalRun, "run.started");
    const server = await channelServer({ runtime: harness.runtimeDirectory });
    harness.cleanup(() => {
      server.child.kill();
    });
    service.decide(approval);
    const [message] = await server.sent(1);
    await delay(testMilliseconds(300));
    const output = await server.end();
    assert.equal(output.status, 0, output.stderr);
    assert.equal(server.channel().length, 1);
    assert.deepEqual(message, {
      content:
        "Run run-60c4… (#701 CLV-336: Answer decisions in the browser) waits for your approval: Approve the change of the watch page? Answer with cloving_questions and cloving_approve or cloving_deny.",
      meta: {
        run_id: approvalRun.runId,
        kind: "decision",
        workflow: "develop",
        ticket: "CLV-336",
        decision_id: approval.decisionId,
      },
    });
  }));

const stoppedRuns = {
  paused: {
    runId: "run-paused0000",
    workflowId: "develop",
    state: "paused",
    revision: 2,
    title: "Paused work",
    reason: { code: "paused", detail: "The operator paused the run." },
  },
  failed: {
    runId: "run-failed0000",
    workflowId: "develop",
    state: "failed",
    title: "Failed work",
    reason: {
      code: "turn-failed",
      detail: "The turn ended with status 1.\nMore.",
    },
  },
  blocked: {
    runId: "run-blocked000",
    workflowId: "develop",
    state: "completed",
    title: "Blocked work",
    outcome: { kind: "blocked", reason: "The ticket needs a decision." },
  },
};

const scheduleStop = {
  workflowId: "patrol",
  stops: [
    {
      stoppedAt: 900_000,
      stoppedSlot: 3,
      failedRunIds: ["run-one", "run-two", "run-three00000"],
    },
  ],
};

const resumedStop = {
  workflowId: "review",
  stops: [
    {
      stoppedAt: 800_000,
      stoppedSlot: 2,
      failedRunIds: ["run-a", "run-b", "run-resumed00"],
    },
  ],
};

const stopMessages = new Map([
  [
    "paused",
    {
      meta: { run_id: "run-paused0000", kind: "paused", workflow: "develop" },
      content:
        "Run run-paus… (Paused work) is paused: The operator paused the run. Resume it with cloving_resume, or drop it with cloving_drop.",
    },
  ],
  [
    "failed",
    {
      meta: { run_id: "run-failed0000", kind: "failed", workflow: "develop" },
      content:
        "Run run-fail… (Failed work) failed: The turn ended with status 1. Continue it with cloving_continue, or dismiss it with cloving_dismiss.",
    },
  ],
  [
    "blocked",
    {
      meta: { run_id: "run-blocked000", kind: "blocked", workflow: "develop" },
      content:
        "Run run-bloc… (Blocked work) is blocked: The ticket needs a decision. Continue it with cloving_continue, or dismiss it with cloving_dismiss.",
    },
  ],
  [
    "schedule_stopped",
    {
      meta: {
        run_id: "run-three00000",
        kind: "schedule_stopped",
        workflow: "patrol",
      },
      content:
        "The schedule of patrol stopped after three failed runs; the last one is run-thre…. Resume it with cloving_schedule_resume.",
    },
  ],
]);

await test("CLV-338 paused, failed and blocked runs and a stopped schedule each give one message of their kind", () =>
  withHarness(async (harness) => {
    const service = await channelService(harness.runtimeDirectory);
    harness.cleanup(() => service.close());
    const server = await channelServer({ runtime: harness.runtimeDirectory });
    harness.cleanup(() => {
      server.child.kill();
    });
    service.run(stoppedRuns.paused, "run.paused");
    service.run(stoppedRuns.failed, "run.failed");
    service.run(stoppedRuns.blocked, "run.completed");
    service.run(
      {
        ...stoppedRuns.failed,
        runId: "run-continued0",
        continuedBy: "run-next",
      },
      "run.failed",
    );
    service.run(
      { ...stoppedRuns.blocked, runId: "run-dismissed0", dismissed: true },
      "run.dismissed",
    );
    service.stop(scheduleStop, "run-three00000");
    await server.sent(4);
    service.run(stoppedRuns.failed, "run.renamed");
    await delay(testMilliseconds(300));
    const output = await server.end();
    assert.equal(output.status, 0, output.stderr);
    assert.equal(server.channel().length, 4);
    assert.deepEqual(
      new Map(
        server.channel().map((message) => {
          const meta = fields(message["meta"]);
          return [String(meta["kind"]), { meta, content: message["content"] }];
        }),
      ),
      stopMessages,
    );
  }));

await test("CLV-338 a server start sends the open items and skips continued and dismissed runs and resumed schedules", () =>
  withHarness(async (harness) => {
    const service = await channelService(harness.runtimeDirectory);
    harness.cleanup(() => service.close());
    service.run(stoppedRuns.failed, "run.failed");
    service.run(
      {
        ...stoppedRuns.failed,
        runId: "run-continued0",
        continuedBy: "run-next",
      },
      "run.failed",
    );
    service.run(
      { ...stoppedRuns.blocked, runId: "run-dismissed0", dismissed: true },
      "run.dismissed",
    );
    service.run(approvalRun, "run.started");
    service.decide(approval);
    service.stopped(scheduleStop);
    service.stopped(resumedStop);
    service.resumed(resumedStop.workflowId);
    const server = await channelServer({ runtime: harness.runtimeDirectory });
    harness.cleanup(() => {
      server.child.kill();
    });
    await server.sent(3);
    await delay(testMilliseconds(300));
    const output = await server.end();
    assert.equal(output.status, 0, output.stderr);
    assert.deepEqual(
      server
        .channel()
        .map((message) => fields(message["meta"]))
        .map((meta) => `${String(meta["kind"])}:${String(meta["run_id"])}`)
        .toSorted(),
      [
        `decision:${approvalRun.runId}`,
        "failed:run-failed0000",
        "schedule_stopped:run-three00000",
      ],
    );
  }));

function kindsOf(messages: readonly Fields[]): readonly string[] {
  return messages
    .map((message) => fields(message["meta"]))
    .map((meta) => `${String(meta["kind"])}:${String(meta["run_id"])}`)
    .toSorted();
}

await test("CLV-338 a restart of the server repeats no message and sends what opened while it was down", () =>
  withHarness(async (harness) => {
    const service = await channelService(harness.runtimeDirectory);
    harness.cleanup(() => service.close());
    const first = await channelServer({ runtime: harness.runtimeDirectory });
    harness.cleanup(() => {
      first.child.kill();
    });
    service.run(approvalRun, "run.started");
    service.decide(approval);
    service.run(stoppedRuns.failed, "run.failed");
    await first.sent(2);
    service.run(approvalRun, "run.observed");
    await delay(testMilliseconds(300));
    assert.equal((await first.end()).status, 0);
    assert.deepEqual(kindsOf(first.channel()), [
      `decision:${approvalRun.runId}`,
      "failed:run-failed0000",
    ]);
    const journal = join(harness.runtimeDirectory, "channel-events.json");
    assert.equal((await stat(journal)).mode & 0o777, 0o600);
    service.run(stoppedRuns.paused, "run.paused");
    const second = await channelServer({ runtime: harness.runtimeDirectory });
    harness.cleanup(() => {
      second.child.kill();
    });
    await second.sent(1);
    await delay(testMilliseconds(300));
    assert.equal((await second.end()).status, 0);
    assert.deepEqual(kindsOf(second.channel()), ["paused:run-paused0000"]);
  }));
