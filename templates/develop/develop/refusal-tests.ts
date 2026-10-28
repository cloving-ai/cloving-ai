import assert from "node:assert/strict";
import { fakeStepBridge } from "cloving/workflows/testing";
import { reportOf } from "./report.ts";
import { openPull } from "./pull.ts";
import { commit, input, completed } from "./scenarios.ts";
import type { FlowTest } from "./flow-tests.ts";
import { develop } from "../develop.ts";
import { effects } from "./scenarios.ts";

export const refusalTests: FlowTest[] = [];

for (const operation of [
  "claude run-turn",
  "github open-pr",
  "github wait-review",
  "github merge",
]) {
  refusalTests.push({
    name: `CLV-221 a ${operation} failure survives a blocked label failure`,
    run: async () => {
      using bridge = fakeStepBridge({
        effects: {
          ...effects(),
          [operation]: [
            {
              kind: "failed",
              operationId: "development-failed",
              reason: "development-failed",
            },
          ],
          "github label": [
            completed({}),
            {
              kind: "failed",
              operationId: "label-failed",
              reason: "label-failed",
            },
          ],
        },
      });
      await assert.rejects(develop(input), (error) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.message, "development-and-label-failed");
        assert.deepEqual(error.errors, [
          new Error("development-failed"),
          new Error("label-failed"),
        ]);
        assert.equal(error.cause, error.errors[1]);
        return true;
      });
      const last = bridge.requests.at(-1);
      assert.ok(last && last[0] === "effect");
      assert.equal(last[1].method, "label");
      assert.equal(last[1].scope.key, "blocked");
    },
  });
}

refusalTests.push({
  name: "CLV-221 a failed lifecycle label stops before the worker runs",
  run: async () => {
    for (const reason of ["label-unavailable", null]) {
      using bridge = fakeStepBridge({
        effects: {
          ...effects(),
          "github label": [
            {
              kind: "failed",
              operationId: "label-failed",
              reason,
            },
          ],
        },
      });
      await assert.rejects(develop(input), { message: reason ?? "failed" });
      assert.equal(bridge.requests.length, 2);
    }
  },
});

refusalTests.push({
  name: "CLV-221 a truncated worker summary preserves structured partial status",
  run: () => {
    const status = { kind: "partial", remaining: ["Verify recovery."] };
    assert.deepEqual(
      reportOf(
        completed({ summary: "Report was truncated.", ticketStatus: status }),
      ),
      { summary: "Report was truncated.", status },
    );
    assert.throws(() => reportOf({ ...completed({}), result: null }), {
      message: "invalid-development-report",
    });
    assert.throws(
      () =>
        reportOf({ kind: "failed", operationId: "turn-failed", reason: null }),
      { message: "failed" },
    );
  },
});

refusalTests.push({
  name: "CLV-221 invalid worker reports cannot open a pull request",
  run: () => {
    assert.throws(
      () =>
        reportOf({
          kind: "failed",
          operationId: "failed-operation",
          reason: "worker-failed",
        }),
      {
        message: "worker-failed",
      },
    );
    for (const value of [null, {}, { summary: 42 }])
      assert.throws(() => reportOf(completed(value)), {
        message: "invalid-development-report",
      });
  },
});

refusalTests.push({
  name: "CLV-221 malformed pull identities cannot reach review or merge",
  run: async () => {
    for (const value of [
      null,
      {},
      { number: 7 },
      { number: 7, url: "pull/7" },
      { number: "7", url: "pull/7", commit },
      { number: NaN, url: "pull/7", commit },
      { number: 0, url: "pull/7", commit },
      { number: 7, url: null, commit },
      { number: 7, url: "pull/7", commit: 42 },
      { number: 7, url: "pull/7", commit: "short" },
    ]) {
      using bridge = fakeStepBridge({ turn: completed(value) });
      await assert.rejects(
        openPull({
          input: {
            cycleId: input.cycleId,
            repository: input.repository,
            ticket: "Fix the counter.",
          },
          round: 1,
        }),
        { message: "invalid-pull-request" },
      );
      assert.equal(bridge.requests.length, 1);
    }
    using bridge = fakeStepBridge({
      turn: {
        kind: "failed",
        operationId: "failed-operation",
        reason: "open-failed",
      },
    });
    await assert.rejects(
      openPull({
        input: {
          cycleId: input.cycleId,
          repository: input.repository,
          ticket: "Fix the counter.",
        },
        round: 1,
      }),
      { message: "open-failed" },
    );
    assert.equal(bridge.requests.length, 1);
  },
});
