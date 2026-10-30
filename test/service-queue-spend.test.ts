import assert from "node:assert/strict";
import { test } from "node:test";
import { openAuthority } from "../src/broker/actor/authority.ts";
import { queueSpend } from "../src/service/queue-spend.ts";
import { withQueueSpend } from "./queue-spend-fixture.ts";
import { record } from "../src/protocol.ts";
import { call, eventually } from "./service-fixture.ts";

await test("CLV-241 spend reads only queue reports with a settlement inside the window", () =>
  withQueueSpend(async (scene) => {
    scene.clock.now = "2026-10-09T12:00:00.000Z";
    const expired = await scene.begin("expired");
    const pending = await scene.begin("pending");
    await scene.turn(expired, { costUsd: 1000 });
    scene.clock.now = "2026-10-10T11:00:00.000Z";
    const settle = await scene.pendingTurn(pending);
    scene.clock.now = "2026-10-10T12:00:00.000Z";
    await scene.finish(expired);
    await settle({ costUsd: 4 });
    await scene.finish(pending);
    const manual = await scene.begin("manual", "manual");
    await scene.turn(manual, { costUsd: 2000 });
    await scene.finish(manual);
    await scene.stop();
    const opening = await openAuthority(scene.harness.stateDirectory);
    assert.equal(opening.kind, "opened");
    const { authority } = opening;
    const read: string[] = [];
    try {
      const spend = await queueSpend({
        clock: () => scene.clock.now,
        queueDailySpendLimitUsd: 20,
        authority: {
          ...authority,
          state: () => Promise.reject(new Error("spend-history-scan")),
          effects: {
            ...authority.effects,
            operations: () => Promise.reject(new Error("spend-history-scan")),
          },
          queries: {
            ...authority.queries,
            eventsAfter: () => Promise.reject(new Error("spend-history-scan")),
            document: async (digest) => {
              const text = await authority.queries.document(digest);
              if (text !== undefined) read.push(text);
              return text;
            },
          },
        },
      });
      assert.deepEqual(read, ['{"costUsd":4}']);
      assert.deepEqual(spend["spend"], {
        limitUsd: 20,
        spentUsd: 4,
        unknownTurns: 0,
        turnsInWork: 0,
        windowHours: 24,
        holding: false,
      });
    } finally {
      await authority.close();
    }
  }));

await test("CLV-241 shared admission holds new queue runs and preserves admitted retries", () =>
  withQueueSpend(async (scene) => {
    const first = await scene.begin("admitted");
    await scene.turn(first, { costUsd: 17 });
    await scene.finish(first);
    const retry = await call(scene.harness, {
      operation: "run",
      parameters: {
        workflowId: "develop-issue",
        source: "prompt",
        submission: { prompt: "admitted" },
        commandId: "admitted",
      },
    });
    assert.equal(retry["kind"], "run-admitted");
    assert.equal(retry["replayed"], true);
    const refused = await call(scene.harness, queueRequest("new"));
    assert.equal(refused["code"], "queue-spend-limit");
    assert.equal(record((await scene.status())["queue"])?.["busy"], 0);
    await scene.begin("manual", "manual");
    scene.clock.now = "2026-10-11T12:00:00.000Z";
    assert.equal(
      (await call(scene.harness, queueRequest("new")))["kind"],
      "run-admitted",
    );
  }));

await test("CLV-241 admission rechecks spending after next ticket resolution", () =>
  withQueueSpend(async (scene) => {
    const running = await scene.begin("running");
    const barrier = Promise.withResolvers<undefined>();
    scene.resolution.wait = barrier.promise;
    const next = call(scene.harness, queueRequest("next", "next"));
    try {
      await eventually(() =>
        scene.counts.admissions === 2 ? true : undefined,
      );
      await scene.turn(running, { costUsd: 17 });
    } finally {
      barrier.resolve(undefined);
    }
    assert.equal((await next)["code"], "queue-spend-limit");
  }));

await test("CLV-241 pinned queue metadata holds admission for a declared workflow", () =>
  withQueueSpend(async (scene) => {
    const runId = await scene.begin("declared", "queued");
    await scene.turn(runId, { costUsd: 17 });
    await scene.finish(runId);
    const request = queueRequest("declared-next");
    const refused = await call(scene.harness, {
      ...request,
      parameters: { ...request.parameters, workflowId: "queued" },
    });
    assert.equal(refused["code"], "queue-spend-limit");
  }));

function queueRequest(commandId: string, ticket = "specific") {
  return {
    operation: "run",
    parameters: {
      workflowId: "develop-issue",
      source: "ticket",
      submission: { ticket },
      commandId,
    },
  };
}

await test("CLV-241 an exhausted budget leaves no refused turn in work after restart", () =>
  withQueueSpend(async (scene) => {
    const runId = await scene.begin("exhausted");
    const refused = await scene.worker().requestEffect({
      runId,
      commandId: "over-budget",
      scope: { phase: "work", operation: "turn", round: 1 },
      capability: "claude",
      method: "run-turn",
      target: "workspace/main",
      payload: "Work",
      units: 21,
    });
    assert.equal(refused.operation?.status, "refused");
    assert.equal(refused.operation.reason, "budget-exhausted");
    await scene.finish(runId);
    await scene.stop();
    const opening = await openAuthority(scene.harness.stateDirectory);
    assert.equal(opening.kind, "opened");
    try {
      assert.deepEqual(
        (
          await queueSpend({
            authority: opening.authority,
            clock: () => scene.clock.now,
            queueDailySpendLimitUsd: 20,
          })
        )["spend"],
        {
          limitUsd: 20,
          spentUsd: 0,
          unknownTurns: 0,
          turnsInWork: 0,
          windowHours: 24,
          holding: false,
        },
      );
    } finally {
      await opening.authority.close();
    }
  }));
