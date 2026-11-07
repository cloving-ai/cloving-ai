import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeStepBridge } from "cloving/workflows/testing";
import { rescuePr } from "./rescue-pr.ts";
import {
  accepted,
  approvals,
  completed,
  effects,
  failedMerges,
  input,
  methods,
  payloads,
  prompts,
  target,
} from "./rescue-pr/scenarios.ts";

await test("CLV-305 rescue-pr with an accepted review and green checks merges the pull request", async () => {
  using bridge = fakeStepBridge({
    effects: effects(),
    decisions: approvals(),
  });
  assert.deepEqual(await rescuePr(input), {
    kind: "handoff_requested",
    cycleId: "rescue-1",
    promotionId: "pull-request-641",
  });
  assert.deepEqual(
    methods(bridge.requests),
    ["prepare", "run-turn", "open-pr"].concat(accepted(), [
      "merge",
      "close-issue",
    ]),
  );
  assert.deepEqual(payloads(bridge.requests, "prepare"), [
    { pullRequest: 641 },
  ]);
  assert.deepEqual(
    bridge.requests.flatMap((request) =>
      request[0] === "effect" && request[1].method !== "prepare"
        ? [request[1].target]
        : [],
    ),
    bridge.requests
      .filter(
        (request) => request[0] === "effect" && request[1].method !== "prepare",
      )
      .map(() => target),
  );
  assert.deepEqual(payloads(bridge.requests, "close-issue"), [
    { owner: "acme", repository: "demo", number: 627, pullRequest: 641 },
  ]);
});

await test("CLV-305 rescue-pr closes the ticket only when the original worker reported complete", async () => {
  for (const given of [
    { pullRequest: 641, issue: "acme/demo#627", ticketStatus: "partial" },
    { pullRequest: 641, ticketStatus: "complete" },
    { pullRequest: 641 },
  ]) {
    using bridge = fakeStepBridge({
      effects: effects(),
      decisions: approvals(),
    });
    assert.deepEqual(await rescuePr({ ...input, input: given }), {
      kind: "handoff_requested",
      cycleId: "rescue-1",
      promotionId: "pull-request-641",
    });
    assert.deepEqual(payloads(bridge.requests, "close-issue"), []);
    assert.equal(methods(bridge.requests).at(-1), "merge");
  }
});

await test("CLV-305 the rescue turn merges the default branch and a failed CI gives its output to the next turn", async () => {
  using bridge = fakeStepBridge({
    effects: { ...effects(2), "github merge": failedMerges(["ci-failed"]) },
    decisions: approvals(2),
  });
  assert.equal((await rescuePr(input)).kind, "handoff_requested");
  const [first, second] = prompts(bridge.requests);
  assert.match(String(first), /^Rescue pull request #641 in this worktree/);
  assert.match(
    String(first),
    /Merge the default branch origin\/main into this branch\./,
  );
  assert.match(String(first), /stopped: merge-conflict\./);
  assert.match(String(first), /gh pr checks 641 .+gh pr view 641 --comments/);
  assert.match(String(second), /This is fix round 2\. Address ci-failed/);
  assert.match(String(second), /Output:\nOutput of ci-failed\.$/);
  assert.equal(payloads(bridge.requests, "close-issue").length, 1);
});

await test("CLV-305 rescue-pr blocks after four rounds or on a reason that a fix cannot answer", async () => {
  for (const [reasons, reason, evidenceId] of [
    [
      ["check-failed", "ci-failed", "merge-conflict", "ci-failed"],
      "ci-failed",
      "rescue",
    ],
    [["ci-pending"], "ci-pending", "merge"],
  ] as const) {
    using bridge = fakeStepBridge({
      effects: { ...effects(4), "github merge": failedMerges(reasons) },
      decisions: approvals(4),
    });
    assert.deepEqual(await rescuePr(input), {
      kind: "blocked",
      cycleId: "rescue-1",
      reason,
      evidenceId,
    });
    assert.equal(prompts(bridge.requests).length, reasons.length);
    assert.deepEqual(payloads(bridge.requests, "close-issue"), []);
  }
});

await test("CLV-305 a refused prepare, a changed pull request or an invalid input blocks the rescue", async () => {
  for (const [given, effect, reason, requested] of [
    [
      input.input,
      {
        "github prepare": [
          {
            kind: "failed" as const,
            operationId: "prepare",
            reason: "pull-request-not-cloving",
          },
        ],
      },
      "pull-request-not-cloving",
      ["prepare"],
    ],
    [
      input.input,
      {
        ...effects(),
        "github open-pr": [
          completed({ number: 642, url: "pull/642", commit: "c".repeat(40) }),
        ],
      },
      "pull-request-changed",
      ["prepare", "run-turn", "open-pr"],
    ],
    [
      { pullRequest: 641, issue: "#627" },
      effects(),
      "invalid-rescue-input",
      [],
    ],
    [
      { pullRequest: 641, ticketStatus: "done" },
      effects(),
      "invalid-rescue-input",
      [],
    ],
    [
      input.input,
      {
        ...effects(),
        "github prepare": [completed({ target: "../main", base: "main" })],
      },
      "invalid-rescue-result",
      ["prepare"],
    ],
  ] as const) {
    using bridge = fakeStepBridge({ effects: effect, decisions: approvals() });
    assert.deepEqual(await rescuePr({ ...input, input: given }), {
      kind: "blocked",
      cycleId: "rescue-1",
      reason,
      evidenceId: "rescue",
    });
    assert.deepEqual(methods(bridge.requests), requested);
  }
});
