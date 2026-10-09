import assert from "node:assert/strict";
import { test } from "node:test";
import { authorizeEffect } from "../src/effect-authorization.ts";

const manifest = { capabilities: ["fake-harness", "tracker"] };

await test("CLV-005 an admitted capability within the persisted budget is authorized", () => {
  assert.deepEqual(
    authorizeEffect(
      manifest,
      { limit: 5, spent: 2 },
      { capability: "tracker", units: 3 },
    ),
    { kind: "authorized", spent: 5 },
  );
});

await test("CLV-005 effects outside the pinned capabilities or the persisted budget are rejected", () => {
  for (const [budget, request, reason] of [
    [
      { limit: 5, spent: 0 },
      { capability: "network", units: 1 },
      "unadmitted-capability",
    ],
    [
      { limit: 5, spent: 3 },
      { capability: "tracker", units: 3 },
      "budget-exhausted",
    ],
    [
      { limit: 5, spent: 5 },
      { capability: "tracker", units: 1 },
      "budget-exhausted",
    ],
    [
      { limit: 5, spent: 0 },
      { capability: "tracker", units: -1 },
      "invalid-effect-request",
    ],
    [
      { limit: 5, spent: 5 },
      { capability: "tracker", units: 0 },
      "invalid-effect-request",
    ],
    [
      { limit: 5, spent: 0 },
      { capability: "tracker", units: 0.5 },
      "invalid-effect-request",
    ],
    [
      { limit: Number.POSITIVE_INFINITY, spent: 0 },
      { capability: "tracker", units: 1 },
      "invalid-effect-request",
    ],
    [
      { limit: 5, spent: 6 },
      { capability: "tracker", units: 0 },
      "invalid-effect-request",
    ],
  ] as const)
    assert.deepEqual(authorizeEffect(manifest, budget, request), {
      kind: "rejected",
      reason,
    });
});
