import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeStepBridge } from "cloving/workflows/testing";
import { reviewDay } from "../templates/review-day/review-day.ts";
import {
  effectText,
  fields,
} from "../templates/review-day/review-day/facts.ts";
import {
  parseReport,
  proposalText,
  type ReviewReport,
} from "../templates/review-day/review-day/report.ts";
import { enforceCritique } from "../templates/review-day/review-day/critique.ts";
import { reviewTurn } from "../templates/review-day/review-day/turn.ts";
import { postAfterPrivacy } from "../templates/review-day/review-day/post.ts";
import { turnReport } from "../src/daemon/turn-report.ts";
import { streamResult } from "../src/daemon/claude-turn.ts";
import { claudeLimits } from "../src/daemon/claude-worker.ts";
import { git, withScene } from "./claude-worker-fixture.ts";
import {
  completed,
  effects,
  report,
  proposal,
  input,
} from "../templates/review-day/review-day/scenarios.ts";

await test("CLV-200 both turns bound their JSON contract below worker limits", () =>
  withScene(async (scene) => {
    const base = {
      ...report,
      facts: '語\n"'.repeat(1000),
      proposals: [{ ...proposal, text: "Measured change." }],
    };
    const summary = JSON.stringify({
      ...base,
      watchList: "x".repeat(
        12000 - JSON.stringify(base).length + base.watchList.length,
      ),
    });
    assert.equal(summary.length, 12000);
    const result = streamResult(
      JSON.stringify({ type: "result", result: summary }),
    );
    assert.ok(result);
    const transported = await turnReport(
      {
        tree: {
          path: scene.repository,
          branch: "main",
          startCommit: git(scene.repository, ["rev-parse", "HEAD"]),
        },
        harness: { worker: "claude" },
        limits: claudeLimits,
      },
      result,
    );
    assert.ok(transported.text);
    assert.equal(transported.reason, undefined);
    using bridge = fakeStepBridge({
      effects: {
        "claude run-turn": [
          { ...completed(), result: transported.text },
          { ...completed(), result: transported.text },
        ],
      },
    });
    let draft: ReviewReport | null = null;
    for (const phase of ["analyze", "critique"] as const) {
      const actual = await reviewTurn(input, {
        phase,
        facts: { report: {}, reviews: [], improvements: [] },
        draft,
      });
      assert.deepEqual(actual, parseReport(JSON.parse(summary)));
      const request = bridge.requests.at(-1);
      assert.ok(request?.[0] === "effect");
      assert.match(
        request[1].payload,
        /at most 12000 characters of serialized JSON/,
      );
      assert.ok(request[1].payload.endsWith(JSON.stringify(draft)));
      draft = actual;
    }
  }));

await test("CLV-200 oversized JSON cannot bypass the turn contract through a fake bridge", async () => {
  using bridge = fakeStepBridge({
    effects: {
      "claude run-turn": [
        completed({
          summary: JSON.stringify({ ...report, facts: "x".repeat(12000) }),
        }),
      ],
    },
  });
  await assert.rejects(
    reviewTurn(input, {
      phase: "analyze",
      facts: { report: {}, reviews: [], improvements: [] },
      draft: null,
    }),
    /review-report-too-large/,
  );
  assert.equal(bridge.requests.length, 1);
});

await test("CLV-200 evidence formatting preserves parsing at the turn contract boundary", () => {
  const base = {
    ...report,
    proposals: [{ ...proposal, text: "Measured change." }],
  };
  const bounded = {
    ...base,
    watchList: "x".repeat(
      12000 - JSON.stringify(base).length + base.watchList.length,
    ),
  };
  assert.equal(JSON.stringify(bounded).length, 12000);
  const parsed = parseReport(bounded);
  assert.deepEqual(parseReport(parsed), parsed);
  assert.equal(JSON.stringify(parsed).length, 12000);
});

await test("CLV-200 turn worktrees are discarded before posting on success and turn failures", async () => {
  const valid = completed({ summary: JSON.stringify(report) });
  const failed = {
    kind: "failed" as const,
    operationId: "turn",
    reason: "turn-failed",
  };
  for (const scenario of [
    {
      turns: [valid, valid],
      kind: "handoff_requested",
      after: ["create-issue", "label"],
    },
    { turns: [failed], kind: "blocked", after: [] },
    { turns: [valid, failed], kind: "blocked", after: [] },
    { turns: [completed({ summary: "{" })], kind: "blocked", after: [] },
  ]) {
    using bridge = fakeStepBridge({
      effects: {
        ...effects(),
        "claude run-turn": scenario.turns,
        "github discard": [completed()],
      },
    });
    const outcome = await reviewDay(input);
    const discarded = bridge.requests.findIndex(
      (request) => request[0] === "effect" && request[1].method === "discard",
    );
    assert.equal(discarded, 3 + scenario.turns.length);
    const request = bridge.requests[discarded];
    assert.ok(request?.[0] === "effect");
    assert.equal(request[1].capability, "github");
    assert.equal(request[1].target, input.cycleId);
    assert.equal(request[1].payload, "{}");
    assert.equal(outcome.kind, scenario.kind);
    assert.deepEqual(
      bridge.requests
        .slice(discarded + 1)
        .map((request) =>
          request[0] === "effect" ? request[1].method : request[0],
        ),
      scenario.after,
    );
  }
});

await test("CLV-200 failed cleanup blocks before posting or deciding", async () => {
  using bridge = fakeStepBridge({
    effects: {
      ...effects(),
      "github discard": [
        { kind: "failed", operationId: "discard", reason: "discard-failed" },
      ],
    },
  });
  const outcome = await reviewDay(input);
  assert.equal(outcome.kind, "blocked");
  assert.equal("reason" in outcome ? outcome.reason : null, "discard-failed");
  assert.ok(
    bridge.requests.every(
      (request) =>
        request[0] === "effect" && request[1].method !== "create-issue",
    ),
  );
});

await test("CLV-200 evidence-only links survive posting, approval and the child input", async () => {
  const draft = {
    ...report,
    proposals: [{ ...proposal, text: "Measured change." }],
  };
  using bridge = fakeStepBridge({
    effects: {
      ...effects(),
      "claude run-turn": [
        completed({ summary: JSON.stringify(draft) }),
        completed({ summary: JSON.stringify(draft) }),
      ],
    },
    decisions: [{ decision: "approved", answer: "1" }],
    waits: [
      { kind: "handoff_requested", promotionId: "issue-42", reason: null },
    ],
  });
  const outcome = await reviewDay(input);
  const expected =
    "Loop: merge\n\nMeasured change.\n\nEvidence:\n" +
    proposal.evidence.map((link) => `- ${link}`).join("\n");
  assert.ok("report" in outcome && typeof outcome.report === "string");
  assert.ok(outcome.report.includes(expected));
  const decision = bridge.requests.find(
    (request) => request[0] === "waitForDecision",
  );
  assert.ok(decision?.[0] === "waitForDecision");
  assert.ok(decision[1].prompt.includes(expected));
  assert.deepEqual(
    bridge.requests.find((request) => request[0] === "handoff"),
    ["handoff", { workflowId: "idea-to-issue", input: { idea: expected } }],
  );
  const posted = bridge.requests.find(
    (request) =>
      request[0] === "effect" && request[1].method === "create-issue",
  );
  assert.ok(posted?.[0] === "effect");
  assert.equal(fields(JSON.parse(posted[1].payload))["text"], outcome.report);
  const parsed = parseReport(draft);
  assert.deepEqual(parseReport(parsed), parsed);
});

await test("CLV-200 blank and whitespace improvement loops prevent proposals and decisions", async () => {
  const draft = { ...report, proposals: [proposal] };
  for (const loop of ["", " \t\n", " merge ", null, undefined]) {
    using bridge = fakeStepBridge({
      effects: {
        ...effects(),
        "command run:improvements": [
          completed([{ number: 8, ...(loop === undefined ? {} : { loop }) }]),
        ],
        "claude run-turn": [
          completed({ summary: JSON.stringify(draft) }),
          completed({ summary: JSON.stringify(draft) }),
        ],
      },
      decisions: [{ decision: "denied", answer: null }],
    });
    const outcome = await reviewDay(input);
    assert.equal(outcome.kind, "handoff_requested");
    assert.ok("report" in outcome && typeof outcome.report === "string");
    assert.match(outcome.report, /## Proposals\n\nNone\./);
    assert.match(outcome.report, /merge-time: open improvement/);
    assert.ok(
      bridge.requests.every((request) => request[0] !== "waitForDecision"),
    );
  }
});

await test("CLV-200 proposal text always carries its stable loop into the ticket", () => {
  const parsed = parseReport({
    ...report,
    proposals: [{ ...proposal, text: "One measured change." }],
  });
  assert.equal(
    parsed.proposals.map(proposalText).join(""),
    "Loop: merge\n\nOne measured change.\n\nEvidence:\n" +
      proposal.evidence.map((link) => `- ${link}`).join("\n"),
  );
  assert.deepEqual(parseReport(parsed), parsed);
});

for (const scenario of [
  { name: "missing summary", turn: completed({}) },
  { name: "malformed summary", turn: completed({ summary: "{" }) },
  {
    name: "oversized report",
    turn: completed({
      summary: JSON.stringify({ ...report, facts: "x".repeat(65537) }),
    }),
  },
  {
    name: "private diagnostic",
    turn: {
      kind: "failed" as const,
      operationId: "turn",
      reason: "provider failed with private details",
    },
  },
])
  await test(`CLV-200 ${scenario.name} blocks with a stable reason before posting`, async () => {
    using bridge = fakeStepBridge({
      effects: {
        ...effects(),
        "claude run-turn": [scenario.turn, scenario.turn],
      },
    });
    const result = await reviewDay(input);
    assert.equal(result.kind, "blocked");
    assert.ok(
      bridge.requests.every(
        (request) =>
          request[0] !== "effect" || request[1].method !== "create-issue",
      ),
    );
    assert.ok(
      "reason" in result && /^[a-z][a-z0-9-]{0,127}$/.test(result.reason),
    );
  });

await test("CLV-200 effect and report decoders reject incomplete data", () => {
  assert.throws(
    () =>
      effectText({
        kind: "completed",
        operationId: "turn",
        receipt: null,
        result: null,
      }),
    /missing-review-result/,
  );
  assert.throws(
    () => effectText({ kind: "failed", operationId: "turn", reason: null }),
    /failed/,
  );
  for (const value of [null, [], 7])
    assert.throws(() => fields(value), /invalid-review-facts/);
  for (const value of [
    { ...report, proposals: null },
    { ...report, facts: " " },
    { ...report, removed: null },
    { ...report, removed: [7] },
    { ...report, proposals: [{ ...proposal, evidence: [7] }] },
  ])
    assert.throws(() => parseReport(value), /invalid-review-report/);
});

await test("CLV-200 critique lists omitted and rewritten proposals and refuses unknown loops and nonlinks", () => {
  const draft = parseReport({ ...report, proposals: [proposal] });
  const facts = { report: {}, reviews: [], improvements: [] };
  const rewritten = { ...proposal, text: "A different change." };
  assert.deepEqual(
    enforceCritique(draft, {
      facts,
      critique: { ...draft, proposals: [rewritten] },
    }).proposals,
    [],
  );
  assert.match(
    enforceCritique(draft, {
      facts,
      critique: { ...draft, proposals: [] },
    }).removed.join(" "),
    /removed by critique/,
  );
  assert.deepEqual(
    enforceCritique(draft, {
      facts: { ...facts, improvements: [{ body: "Unknown loop." }] },
      critique: draft,
    }).proposals,
    [],
  );
  const nonlink = { ...proposal, evidence: ["unsupported"] };
  const invalid = { ...draft, proposals: [nonlink] };
  assert.deepEqual(
    enforceCritique(invalid, { facts, critique: invalid }).proposals,
    [],
  );
  const duplicate = enforceCritique(draft, {
    facts,
    critique: { ...draft, proposals: [proposal, proposal] },
  });
  assert.equal(duplicate.proposals.length, 1);
  assert.match(duplicate.removed.join(" "), /duplicate proposal/);
});

await test("CLV-200 malformed issue results stop before any label", async () => {
  for (const number of [null, 0, 1.5, "42", 9007199254740992]) {
    using bridge = fakeStepBridge({
      effects: { "github create-issue": [completed({ number })] },
    });
    await assert.rejects(
      postAfterPrivacy(input, "# Daily review"),
      /invalid-review-issue/,
    );
    assert.equal(bridge.requests.length, 1);
  }
});
