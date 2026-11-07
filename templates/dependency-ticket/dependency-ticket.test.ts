import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeStepBridge } from "cloving/workflows/testing";
import { dependencyTicket } from "./dependency-ticket.ts";
import {
  completed,
  created,
  effects,
  input,
  text,
} from "./dependency-ticket/scenarios.ts";

await test("CLV-318 the ticket run creates one issue from the text and adds the security label", async () => {
  using bridge = fakeStepBridge({ effects: created(42), effectLimit: 2 });
  assert.deepEqual(await dependencyTicket(input), {
    kind: "handoff_requested",
    cycleId: input.cycleId,
    promotionId: "issue-42",
    report: "Created the security issue #42.",
  });
  assert.deepEqual(effects(bridge.requests), [
    ["create-issue", { text }],
    ["label", { number: 42, add: ["cloving: security"], remove: [] }],
  ]);
});

await test("CLV-318 a failed or invalid issue blocks the ticket run before the label", async () => {
  for (const [result, reason] of [
    [
      {
        kind: "failed" as const,
        operationId: "post",
        reason: "private-path-in-change",
      },
      "private-path-in-change",
    ],
    [
      { kind: "stopped" as const, operationId: "post", reason: null },
      "stopped",
    ],
    [
      {
        kind: "completed" as const,
        operationId: "post",
        receipt: null,
        result: null,
      },
      "invalid-issue-result",
    ],
    [
      {
        kind: "completed" as const,
        operationId: "post",
        receipt: null,
        result: "{",
      },
      "invalid-issue-result",
    ],
    [completed({ number: 0 }), "invalid-issue-result"],
    [completed([42]), "invalid-issue-result"],
  ] as const) {
    using bridge = fakeStepBridge({
      effects: { "github create-issue": [result] },
    });
    assert.deepEqual(await dependencyTicket(input), {
      kind: "blocked",
      cycleId: input.cycleId,
      evidenceId: "dependency-ticket",
      reason,
    });
    assert.deepEqual(
      effects(bridge.requests).map(([method]) => method),
      ["create-issue"],
    );
  }
});

await test("CLV-318 a failed label blocks the ticket run after the issue", async () => {
  using bridge = fakeStepBridge({
    effects: Object.assign(created(42), {
      "github label": [
        {
          kind: "failed" as const,
          operationId: "label",
          reason: "Label failed!",
        },
      ],
    }),
  });
  assert.deepEqual(await dependencyTicket(input), {
    kind: "blocked",
    cycleId: input.cycleId,
    evidenceId: "dependency-ticket",
    reason: "dependency-ticket-failed",
  });
  assert.equal(bridge.requests.length, 2);
});
