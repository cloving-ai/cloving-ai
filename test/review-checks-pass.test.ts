import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeStepBridge } from "cloving/workflows/testing";
import { reviewChecks } from "../templates/review-checks/review-checks.ts";
import {
  effects,
  facts,
  input,
  methods,
  suggestion,
} from "../templates/review-checks/review-checks/scenarios.ts";

await test("CLV-316 a pass whose only accept ends with no issue records nothing and blocks with check-issue-missing", async () => {
  using bridge = fakeStepBridge({
    effects: effects(facts(), [
      suggestion({ name: "first-shape", rule: "first-shape" }),
    ]),
    decisions: [{ decision: "answered", answer: "accept" }],
    waits: [
      { kind: "blocked", reason: "invalid-issue-result", promotionId: null },
    ],
    effectLimit: 12,
  });
  assert.deepEqual(await reviewChecks(input), {
    kind: "blocked",
    cycleId: input.cycleId,
    evidenceId: "review-checks",
    reason: "check-issue-missing",
  });
  assert.equal(
    methods(bridge.requests).includes("run:review-checks-record"),
    false,
  );
});
