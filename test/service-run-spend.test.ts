import assert from "node:assert/strict";
import { test } from "node:test";
import { documentDigest } from "../src/broker/decision-restore.ts";
import { effectInputDigest } from "../src/broker/effect-restore.ts";
import { operationIdentity } from "../src/operation-identity.ts";
import { pinnedSpendLimit } from "../src/service/run-spend.ts";
import type { Fields } from "../src/protocol.ts";
import { openedAuthority } from "./authority-actor-fixture.ts";
import { turnRequest, withQueueSpend } from "./queue-spend-fixture.ts";
import { call, field } from "./service-fixture.ts";

function directTurn(
  runId: string,
  given: { readonly round: number; readonly spend: Fields },
) {
  const request = turnRequest(runId, given.round);
  const identity = operationIdentity({ ...request.scope, run: runId });
  if (identity.kind !== "valid") throw new Error(identity.reason);
  const payload = documentDigest(request.payload);
  const { capability, method, target } = request;
  return {
    kind: "request-effect",
    runId,
    commandId: request.commandId,
    operationId: identity.value,
    capability,
    method,
    target,
    payload,
    inputDigest: effectInputDigest({ capability, method, target, payload }),
    units: 1,
    recoveryLimit: 3,
    ...given.spend,
  };
}

await test("CLV-308 the authority reads the recorded cost of a run in its own turn, so a turn request with an old cost or no cost gets spend-limit", () =>
  withQueueSpend(
    async (scene) => {
      const runId = await scene.begin("run-direct", "manual");
      await scene.turn(runId, { costUsd: 1.2 });
      await scene.stop();
      const authority = await openedAuthority(scene.harness.stateDirectory);
      const sent = [
        { round: 2, spend: { spendLimitUsd: 1, recordedCostUsd: 0 } },
        { round: 3, spend: {} },
      ].map((given) => directTurn(runId, given));
      const receipts = [];
      for (const command of sent)
        receipts.push(
          await authority.execute(command, {
            recordedAt: scene.clock.now,
            epoch: authority.epoch,
            documents: ["Work"],
          }),
        );
      const pinned = [
        await pinnedSpendLimit({ authority }, runId),
        await pinnedSpendLimit({ authority }, "run-unknown"),
      ];
      await authority.close();
      assert.deepEqual(pinned, [1, undefined]);
      assert.deepEqual(
        receipts.map((receipt) => [
          receipt.kind,
          "disposition" in receipt ? receipt.disposition : null,
        ]),
        [
          ["accepted", "refused"],
          ["accepted", "refused"],
        ],
      );
    },
    { runSpendLimitUsd: 1 },
  ));

await test("CLV-308 a run with a spend limit of 1 USD and a recorded cost of 1.20 USD gets spend-limit for its next turn effect", () =>
  withQueueSpend(
    async (scene) => {
      const runId = await scene.begin("run-spend", "manual");
      await scene.turn(runId, { costUsd: 0.5 });
      const second = await scene.pendingTurn(runId, 2);
      await second({ costUsd: 0.7 });
      const third = await scene.worker().requestEffect(turnRequest(runId, 3));
      assert.deepEqual(
        [third.receipt.kind, third.operation?.status, third.operation?.reason],
        ["accepted", "refused", "spend-limit"],
      );
      assert.equal(third.disposition?.disposition, "refused");
      const status = await call(scene.harness, {
        operation: "status",
        parameters: { runId },
      });
      assert.deepEqual(
        [
          field(status["run"], "spendLimitUsd"),
          field(status["run"], "claudeCostUsd"),
          field(status["run"], "budget"),
        ],
        [1, 1.2, { spent: 2, limit: 20 }],
      );
    },
    { runSpendLimitUsd: 1 },
  ));

await test("CLV-308 the recorded cost of a run counts each reported price, else the estimate, and a turn with no price counts as zero", () =>
  withQueueSpend(
    async (scene) => {
      const runId = await scene.begin("run-estimates", "manual");
      await scene.turn(runId, {});
      const second = await scene.pendingTurn(runId, 2);
      await second({ estimatedCostUsd: 0.6 });
      const third = await scene.pendingTurn(runId, 3);
      await third({ costUsd: 0.4, estimatedCostUsd: 9 });
      const fourth = await scene.worker().requestEffect(turnRequest(runId, 4));
      assert.deepEqual(
        [fourth.operation?.status, fourth.operation?.reason],
        ["refused", "spend-limit"],
      );
    },
    { runSpendLimitUsd: 1 },
  ));

await test("CLV-308 a resent turn request stays one admission after the recorded cost of the run changes", () =>
  withQueueSpend(
    async (scene) => {
      const runId = await scene.begin("run-resend", "manual");
      const first = await scene.worker().requestEffect(turnRequest(runId, 1));
      assert.equal(first.disposition?.disposition, "admitted");
      const second = await scene.pendingTurn(runId, 2);
      await second({ costUsd: 1.2 });
      const resent = await scene.worker().requestEffect(turnRequest(runId, 1));
      assert.deepEqual(
        [resent.receipt.kind, resent.operation?.operationId],
        ["duplicate", first.operation?.operationId],
      );
    },
    { runSpendLimitUsd: 1 },
  ));

await test("CLV-308 a run of a workflow without a spend limit gets every turn effect", () =>
  withQueueSpend(async (scene) => {
    const runId = await scene.begin("run-unlimited", "manual");
    await scene.turn(runId, { costUsd: 5 });
    const next = await scene.worker().requestEffect(turnRequest(runId, 2));
    assert.equal(next.disposition?.disposition, "admitted");
    const status = await call(scene.harness, {
      operation: "status",
      parameters: { runId },
    });
    assert.equal(field(status["run"], "spendLimitUsd"), null);
    const unknown = await scene
      .worker()
      .requestEffect(turnRequest("run-unknown", 1));
    assert.equal(unknown.operation, null);
  }));
