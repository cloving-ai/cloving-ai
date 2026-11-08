import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeStepBridge } from "cloving/workflows/testing";
import { reviewDay } from "../templates/review-day/review-day.ts";
import {
  completed,
  effects,
  input,
  methods,
} from "../templates/review-day/review-day/scenarios.ts";

await test("CLV-323 a full improvement list blocks the review before any turn", async () => {
  using bridge = fakeStepBridge({
    effects: {
      ...effects(),
      "github issues": [
        completed([]),
        completed(
          Array.from({ length: 100 }, (_, index) => ({
            number: index + 1,
            body: "Loop: merge",
          })),
        ),
      ],
    },
  });
  const outcome = await reviewDay(input);
  assert.equal(outcome.kind, "blocked");
  assert.equal(
    "reason" in outcome ? outcome.reason : null,
    "too-many-improvements",
  );
  assert.deepEqual(methods(bridge.requests), [
    "run:report",
    "issues",
    "issues",
  ]);
});
