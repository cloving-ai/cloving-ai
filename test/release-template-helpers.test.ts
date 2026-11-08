import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeStepBridge } from "cloving/workflows/testing";
import { release } from "../templates/release/release.ts";
import { releaseTask } from "../templates/release/release/input.ts";
import { failureReason } from "../templates/release/release/outcome.ts";
import { afterMerge, askPerson } from "../templates/release/release/publish.ts";
import {
  approvals,
  effects,
  input,
  methods,
  waits,
} from "../templates/release/release/scenarios.ts";

const request = {
  task: releaseTask(input),
  pull: {
    number: 650,
    url: "pull/650",
    commit: "b".repeat(40),
    target: "release-1",
  },
};

await test("CLV-304 Publish after the merge continues to the tag with no decision", async () => {
  using bridge = fakeStepBridge({});
  assert.deepEqual(await afterMerge(request), request);
  assert.deepEqual(bridge.requests, []);
});

await test("CLV-304 an expired or a denied publish decision gives a blocked outcome and an approval continues", async () => {
  for (const [decision, outcome] of [
    ["approved", request],
    [
      "expired",
      {
        kind: "blocked",
        cycleId: "release-1",
        reason: "publish-expired",
        evidenceId: "publish",
      },
    ],
    [
      "denied",
      {
        kind: "blocked",
        cycleId: "release-1",
        reason: "publish-denied",
        evidenceId: "publish",
      },
    ],
  ] as const) {
    using bridge = fakeStepBridge({ decisions: [{ decision, answer: null }] });
    assert.deepEqual(await askPerson(request), outcome);
    assert.deepEqual(methods(bridge.requests), ["waitForDecision"]);
  }
});

await test("CLV-304 a failed effect with no reason, an empty result or an unknown error blocks with a stable reason", async () => {
  for (const [changed, reason] of [
    [
      {
        "github prepare": [
          { kind: "failed" as const, operationId: "prepare", reason: null },
        ],
      },
      "failed",
    ],
    [
      {
        "claude run-turn": [
          {
            kind: "completed" as const,
            operationId: "turn",
            receipt: null,
            result: null,
          },
        ],
      },
      "invalid-release-report",
    ],
  ] as const) {
    using bridge = fakeStepBridge({
      effects: { ...effects(), ...changed },
      commandWaits: waits(),
      decisions: approvals(),
    });
    assert.deepEqual(await release(input), {
      kind: "blocked",
      cycleId: "release-1",
      reason,
      evidenceId: "release",
    });
    assert.equal(methods(bridge.requests).includes("run:push-tag"), false);
  }
  assert.equal(failureReason(new TypeError("Cannot read x")), "release-failed");
  assert.equal(failureReason("not-an-error"), "release-failed");
});
