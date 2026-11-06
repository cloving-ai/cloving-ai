import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeStepBridge } from "cloving/workflows/testing";

type JsonObject = Parameters<typeof completed>[0];
import { rescuePr } from "../templates/rescue-pr/rescue-pr.ts";
import {
  commit,
  completed,
  effects,
  input,
  methods,
  prompts,
} from "../templates/rescue-pr/rescue-pr/scenarios.ts";
import { patrol } from "../templates/patrol/patrol.ts";
import {
  handoffs,
  status,
  stuck,
} from "../templates/patrol/patrol/scenarios.ts";

function review(
  score: number,
  text: { readonly summary: string; readonly findings?: JsonObject[] },
) {
  return completed({
    number: 641,
    commit,
    score,
    summary: text.summary,
    findings: text.findings ?? [],
  });
}

await test("CLV-305 review findings start another rescue turn, and a rejection without feedback blocks", async () => {
  {
    using bridge = fakeStepBridge({
      effects: {
        ...effects(2),
        "github wait-review": [
          review(3, {
            summary: "Fix the counter.",
            findings: [
              { path: "src/counter.ts", line: 4, body: "The count is wrong." },
            ],
          }),
          review(5, { summary: "Good" }),
        ],
      },
    });
    assert.equal((await rescuePr(input)).kind, "handoff_requested");
    const second = String(prompts(bridge.requests).at(1));
    assert.match(second, /Address review-changes/);
    assert.match(second, /Fix the counter\.\n\nsrc\/counter\.ts:4\nThe count/);
  }
  {
    using bridge = fakeStepBridge({
      effects: {
        ...effects(),
        "github wait-review": [review(3, { summary: "" })],
      },
    });
    assert.deepEqual(await rescuePr(input), {
      kind: "blocked",
      cycleId: "rescue-1",
      reason: "review-changes",
      evidenceId: "review",
    });
    assert.deepEqual(methods(bridge.requests), [
      "prepare",
      "run-turn",
      "open-pr",
      "wait-review",
    ]);
  }
});

await test("CLV-305 a failed ticket close keeps the merge and records the issue update", async () => {
  using bridge = fakeStepBridge({
    effects: {
      ...effects(),
      "github close-issue": [
        { kind: "failed", operationId: "close", reason: "github-call-failed" },
      ],
    },
  });
  assert.deepEqual(await rescuePr(input), {
    kind: "handoff_requested",
    cycleId: "rescue-1",
    promotionId: "pull-request-641",
    issueUpdate: "failed",
  });
  assert.equal(methods(bridge.requests).at(-1), "close-issue");
});

await test("CLV-305 invalid effect results block the rescue with their reason", async () => {
  for (const [changed, reason] of [
    [
      {
        "github prepare": [
          { kind: "stopped" as const, operationId: "prepare", reason: null },
        ],
      },
      "stopped",
    ],
    [{ "github prepare": [completed({ items: [] })] }, "invalid-rescue-result"],
    [
      {
        "github prepare": [
          {
            kind: "completed" as const,
            operationId: "prepare",
            receipt: null,
            result: "[]",
          },
        ],
      },
      "invalid-rescue-result",
    ],
    [
      { "github prepare": [completed({ target: "task-1", base: " " })] },
      "invalid-rescue-result",
    ],
    [
      { "github prepare": [{ ...completed({}), result: "{" }] },
      "rescue-failed",
    ],
    [
      { "claude run-turn": [completed({ text: "done" })] },
      "invalid-rescue-report",
    ],
    [
      {
        "github open-pr": [
          completed({ number: 641, url: "pull/641", commit: "HEAD" }),
        ],
      },
      "invalid-rescue-result",
    ],
  ] as const) {
    using bridge = fakeStepBridge({ effects: { ...effects(), ...changed } });
    assert.deepEqual(await rescuePr(input), {
      kind: "blocked",
      cycleId: "rescue-1",
      reason,
      evidenceId: "rescue",
    });
    assert.ok(!methods(bridge.requests).includes("merge"));
  }
});

await test("CLV-305 a rescue without a known ticket hands off only the pull request and the reason", async () => {
  using bridge = fakeStepBridge({
    effects: status([stuck(641, { issue: null, ticketStatus: null })]),
    decisions: [{ decision: "answered", answer: "all" }],
  });
  await patrol({ cycleId: "patrol-1", input: {} });
  assert.deepEqual(handoffs(bridge.requests), [
    {
      workflowId: "rescue-pr",
      input: { pullRequest: 641, reason: "merge-conflict" },
    },
  ]);
});

await test("CLV-305 a patrol status without a result or with an unnamed failure blocks the pass", async () => {
  for (const [result, reason] of [
    [
      {
        kind: "completed" as const,
        operationId: "s",
        receipt: null,
        result: null,
      },
      "invalid-patrol-status",
    ],
    [
      { kind: "failed" as const, operationId: "s", reason: "Exit 2" },
      "patrol-failed",
    ],
    [
      { kind: "unavailable" as const, reason: "cloving-host-unavailable" },
      "cloving-host-unavailable",
    ],
  ] as const) {
    using bridge = fakeStepBridge({
      effects: { "command run:patrol-status": [result] },
    });
    assert.deepEqual(await patrol({ cycleId: "patrol-1", input: {} }), {
      kind: "blocked",
      cycleId: "patrol-1",
      evidenceId: "patrol",
      reason,
    });
    assert.equal(bridge.requests.length, 1);
  }
});

await test("CLV-305 an answer of zero picks no rescue", async () => {
  using bridge = fakeStepBridge({
    effects: status([stuck(641)]),
    decisions: [{ decision: "answered", answer: "0" }],
  });
  await patrol({ cycleId: "patrol-1", input: {} });
  assert.deepEqual(handoffs(bridge.requests), []);
});
