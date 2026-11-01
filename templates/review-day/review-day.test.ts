import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeStepBridge } from "cloving/workflows/testing";
import { reviewDay } from "./review-day.ts";
import { handoffProposal } from "./review-day/next.ts";
import {
  completed,
  effects,
  input,
  report,
  selection,
  methods,
  proposal,
  proposalEffects,
} from "./review-day/scenarios.ts";

await test("CLV-200 failed facts block the review before a report or issue", async () => {
  using bridge = fakeStepBridge({
    effects: {
      "command run:report": [
        { kind: "failed", operationId: "report", reason: "command-exit" },
      ],
    },
  });
  assert.deepEqual(await reviewDay({ cycleId: "review-1", input: {} }), {
    kind: "blocked",
    cycleId: "review-1",
    evidenceId: "review-day",
    reason: "command-exit",
  });
  assert.deepEqual(
    bridge.requests.map((request) =>
      request[0] === "effect" ? request[1].method : request[0],
    ),
    ["run:report"],
  );
});

await test("CLV-200 approval of proposal two waits for idea-to-issue then labels its issue", async () => {
  using bridge = fakeStepBridge({
    effects: proposalEffects(),
    decisions: [{ decision: "answered", answer: "2" }],
    waits: [
      { kind: "handoff_requested", promotionId: "issue-42", reason: null },
    ],
  });
  const outcome = await reviewDay(input);
  assert.equal(outcome.kind, "handoff_requested");
  const prefix = [
    "run:report",
    "run:reviews",
    "run:improvements",
    "run-turn",
    "run-turn",
    ...(selection.post === "privacy" ? ["create-issue", "label"] : []),
    "waitForDecision",
  ];
  assert.deepEqual(methods(bridge.requests), [
    ...prefix,
    ...(selection.next === "idea" ? ["handoff", "waitForRun", "label"] : []),
  ]);
  const handoffs = bridge.requests.filter(
    (request) => request[0] === "handoff",
  );
  assert.deepEqual(
    handoffs,
    selection.next === "idea"
      ? [
          [
            "handoff",
            { workflowId: "idea-to-issue", input: { idea: proposal.text } },
          ],
        ]
      : [],
  );
  const labels = bridge.requests
    .filter(
      (request) => request[0] === "effect" && request[1].method === "label",
    )
    .map((request) => {
      assert.ok(request[0] === "effect");
      const payload: unknown = JSON.parse(request[1].payload);
      return payload;
    });
  assert.deepEqual(labels, [
    ...(selection.post === "privacy"
      ? [{ number: 9, add: ["cloving: review"], remove: [] }]
      : []),
    ...(selection.next === "idea"
      ? [{ number: 42, add: ["cloving: improvement"], remove: [] }]
      : []),
  ]);
});

await test("CLV-200 denial, expiry, none and ambiguous approvals never hand off", async () => {
  for (const decision of [
    { decision: "denied" as const, answer: "2" },
    { decision: "expired" as const, answer: "2" },
    { decision: "answered" as const, answer: "none" },
    { decision: "answered" as const, answer: "1,2" },
    { decision: "approved" as const, answer: null },
    { decision: "approved" as const, answer: "3" },
  ]) {
    using bridge = fakeStepBridge({
      effects: proposalEffects(),
      decisions: [decision],
    });
    assert.equal((await reviewDay(input)).kind, "handoff_requested");
    assert.equal(
      methods(bridge.requests).filter((method) => method === "waitForDecision")
        .length,
      1,
    );
    assert.ok(!methods(bridge.requests).includes("handoff"));
  }
});

await test("CLV-200 missing child issue outcomes block without labeling an earlier issue", async () => {
  for (const promotionId of [
    null,
    "issue-0",
    "issue-4-other",
    "pull-request-42",
  ]) {
    using bridge = fakeStepBridge({
      effects: proposalEffects(),
      decisions: [{ decision: "approved", answer: "1" }],
      waits: [{ kind: "handoff_requested", reason: null, promotionId }],
    });
    await assert.rejects(handoffProposal(input, proposal), {
      message: "improvement-issue-missing",
    });
    assert.equal(bridge.requests.at(-1)?.[0], "waitForRun");
  }
});

await test("CLV-200 both turns carry all review rules and improvement verdict instructions", async () => {
  using bridge = fakeStepBridge({ effects: effects() });
  await reviewDay(input);
  for (const request of bridge.requests) {
    if (request[0] !== "effect" || request[1].method !== "run-turn") continue;
    for (const rule of [
      "Real changes only",
      "outside",
      "7-day band",
      "3 days",
      "inside the band",
      "One constraint",
      "wait time",
      "lost runs",
      "before adding capacity",
      "Paired metrics",
      "merged tickets",
      "reverted or reopened",
      "main CI failures",
      "busy lanes",
      "flaky failures",
      "fix rounds",
      "faster CI",
      "escaped faults",
      "Evidence",
      "2 or more occurrences",
      "trend over 7 days",
      "links",
      "single event",
      "At most 3 proposals",
      "hypothesis",
      "one change",
      "expected effect",
      "3 to 7 days",
      "cost",
      "reverse",
      "failure",
      "One change for each loop",
      "open improvement",
      "Keep what works",
      "80%",
      "lanes",
      "CI runners",
      "host",
      "system, not a person",
      "before and after",
      "check date",
      "keep, reverse or continue",
    ])
      assert.ok(request[1].payload.includes(rule), rule);
  }
});

await test("CLV-200 critique removes unsupported and already-improving loops even if the turn retains them", async () => {
  const draft = {
    ...report,
    proposals: [
      {
        ...proposal,
        id: "no-evidence",
        text: "Unsupported proposal.",
        evidence: [],
      },
      {
        ...proposal,
        id: "busy-loop",
        text: "Conflicting proposal.",
        loop: "develop",
      },
    ],
  };
  using bridge = fakeStepBridge({
    effects: {
      ...effects(),
      "command run:improvements": [
        completed([
          { number: 8, loop: "develop", body: "Existing improvement." },
        ]),
      ],
      "claude run-turn": [
        completed({ summary: JSON.stringify(draft) }),
        completed({ summary: JSON.stringify(draft) }),
      ],
    },
  });
  const outcome = await reviewDay(input);
  assert.equal(outcome.kind, "handoff_requested");
  assert.ok("report" in outcome && typeof outcome.report === "string");
  assert.match(outcome.report, /## Proposals\n\nNone\./);
  assert.match(outcome.report, /no-evidence: missing evidence/);
  assert.match(outcome.report, /busy-loop: open improvement/);
  assert.ok(!methods(bridge.requests).includes("waitForDecision"));
});

await test("CLV-200 critique cannot add or rewrite proposals and the report has at most three", async () => {
  const proposals = [1, 2, 3, 4].map((id) => ({
    ...proposal,
    id: String(id),
    text: `Change ${String(id)}.`,
  }));
  const draft = { ...report, proposals };
  const critique = {
    ...draft,
    proposals: [...proposals, { ...proposal, id: "invented" }],
  };
  using bridge = fakeStepBridge({
    effects: {
      ...effects(),
      "claude run-turn": [
        completed({ summary: JSON.stringify(draft) }),
        completed({ summary: JSON.stringify(critique) }),
      ],
    },
    decisions: [{ decision: "denied", answer: null }],
  });
  const outcome = await reviewDay(input);
  assert.ok("report" in outcome && typeof outcome.report === "string");
  const body =
    outcome.report.split("## Proposals")[1]?.split("## Watch list")[0] ?? "";
  assert.match(body, /Change 3\./);
  assert.doesNotMatch(body, /Change 4\.|invented/);
  assert.match(outcome.report, /invented: not an unchanged analyzed proposal/);
  assert.equal(methods(bridge.requests).at(-1), "waitForDecision");
});

await test("CLV-200 analyzes and critiques facts before posting and opens no decision without proposals", async () => {
  using bridge = fakeStepBridge({ effects: effects() });
  const outcome = await reviewDay(input);
  assert.equal(outcome.kind, "handoff_requested");
  assert.deepEqual(methods(bridge.requests), [
    "run:report",
    "run:reviews",
    "run:improvements",
    "run-turn",
    "run-turn",
    ...(selection.post === "privacy" ? ["create-issue", "label"] : []),
  ]);
  for (const section of [
    "Facts",
    "Went well",
    "Went badly",
    "The constraint",
    "Improvements in progress",
    "Proposals",
    "Watch list",
    "Removed by the critique",
  ])
    assert.ok(
      "report" in outcome &&
        typeof outcome.report === "string" &&
        outcome.report.includes(`## ${section}`),
    );
  const turns = bridge.requests.filter(
    (request) => request[0] === "effect" && request[1].method === "run-turn",
  );
  assert.equal(turns.length, 2);
  assert.ok(
    turns[0]?.[0] === "effect" && turns[0][1].payload.includes('"metrics"'),
  );
  assert.ok(
    turns[1]?.[0] === "effect" &&
      turns[1][1].payload.includes(report.constraint),
  );
});

await test("CLV-200 every failed or invalid JSON command blocks before analysis", async () => {
  for (const name of ["report", "reviews", "improvements"]) {
    for (const result of [
      {
        kind: "completed" as const,
        operationId: name,
        receipt: null,
        result: "{",
      },
      { kind: "failed" as const, operationId: name, reason: "command-exit" },
    ]) {
      using bridge = fakeStepBridge({
        effects: {
          "command run:report": [
            {
              kind: "completed",
              operationId: "r",
              receipt: null,
              result: "{}",
            },
          ],
          "command run:reviews": [
            {
              kind: "completed",
              operationId: "r",
              receipt: null,
              result: "[]",
            },
          ],
          "command run:improvements": [
            {
              kind: "completed",
              operationId: "r",
              receipt: null,
              result: "[]",
            },
          ],
          [`command run:${name}`]: [result],
        },
      });
      const outcome = await reviewDay({ cycleId: "review-1", input: {} });
      assert.equal(outcome.kind, "blocked");
      assert.equal(
        "reason" in outcome ? outcome.reason : null,
        result.kind === "failed" ? "command-exit" : "invalid-review-facts",
      );
      assert.deepEqual(
        bridge.requests.map((request) => {
          assert.equal(request[0], "effect");
          return request[1].method;
        }),
        ["run:report", "run:reviews", "run:improvements"].slice(
          0,
          ["report", "reviews", "improvements"].indexOf(name) + 1,
        ),
      );
    }
  }
});
