import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeStepBridge } from "cloving/workflows/testing";
import { triageIssue } from "./triage-issue.ts";
import { askPerson, postAtOnce } from "./triage-issue/post.ts";
import { triageOf } from "./triage-issue/verdict.ts";
import {
  approvals,
  asked,
  candidates,
  completed,
  duplicateSummary,
  failed,
  handedOff,
  issue,
  methods,
  pass,
  payloads,
  prompts,
  triageEffects,
  turnPrompt,
} from "./triage-issue/scenarios.ts";

await test("CLV-319 the scheduled pass hands off one triage-issue run for each candidate and waits for each run", async () => {
  using bridge = fakeStepBridge({
    effects: Object.assign(candidates([{ number: 639 }, { number: 640 }]), {
      handoff: handedOff(["run-639", "run-640"]),
    }),
    waits: [
      { kind: "handoff_requested", reason: null, promotionId: "triage-639" },
      { kind: "blocked", reason: "private-path-in-change", promotionId: null },
    ],
  });
  const outcome = await triageIssue(pass);
  assert.deepEqual(methods(bridge.requests), [
    "run:triage-candidates",
    "handoff",
    "handoff",
    "waitForRun",
    "waitForRun",
  ]);
  assert.deepEqual(
    bridge.requests.flatMap((request) =>
      request[0] === "handoff" ? [request[1]] : [],
    ),
    [
      { workflowId: "triage-issue", input: { issue: 639 } },
      { workflowId: "triage-issue", input: { issue: 640 } },
    ],
  );
  assert.deepEqual(
    bridge.requests.flatMap((request) =>
      request[0] === "waitForRun" ? [request[1].runId] : [],
    ),
    ["run-639", "run-640"],
  );
  assert.deepEqual(outcome, {
    kind: "handoff_requested",
    cycleId: pass.cycleId,
    promotionId: "triage-pass",
    report:
      "Triage candidates: 2. Runs: #639 handoff_requested, #640 blocked (private-path-in-change).",
  });
});

await test("CLV-319 a duplicate verdict posts a reply that links the closed issue and adds the verdict label", async () => {
  using bridge = fakeStepBridge({
    effects: triageEffects(duplicateSummary),
    decisions: approvals("approved"),
  });
  const outcome = await triageIssue(issue);
  assert.deepEqual(
    methods(bridge.requests),
    ["prepare", "run-turn", "discard"].concat(asked(), [
      "comment-issue",
      "label",
    ]),
  );
  assert.match(turnPrompt(bridge.requests), /issue #639/);
  assert.match(turnPrompt(bridge.requests), /Triage: duplicate #<number>/);
  assert.deepEqual(payloads(bridge.requests, "comment-issue"), [
    { number: 639, body: duplicateSummary },
  ]);
  assert.match(duplicateSummary, /#599/);
  assert.deepEqual(payloads(bridge.requests, "label"), [
    {
      number: 639,
      add: ["cloving: triaged", "cloving: duplicate"],
      remove: [],
    },
  ]);
  assert.deepEqual(outcome, {
    kind: "handoff_requested",
    cycleId: issue.cycleId,
    promotionId: "triage-639",
    report: "Triage of #639: duplicate #599. The reply is posted.",
  });
});

const task = { cycleId: issue.cycleId, issue: 639 };

await test("CLV-319 A person approves shows the verdict and the reply and posts nothing before the approval", async () => {
  using bridge = fakeStepBridge({
    effects: triageEffects(duplicateSummary),
    decisions: [{ decision: "approved", answer: null }],
  });
  await askPerson(triageOf(task, duplicateSummary));
  assert.deepEqual(methods(bridge.requests), [
    "waitForDecision",
    "comment-issue",
    "label",
  ]);
  assert.match(prompts(bridge.requests), /Verdict: duplicate #599/);
  assert.ok(prompts(bridge.requests).includes(duplicateSummary));
});

await test("CLV-319 a denied or expired approval posts no comment and adds only cloving: triaged", async () => {
  for (const decision of ["denied", "expired"] as const) {
    using bridge = fakeStepBridge({
      effects: triageEffects(duplicateSummary),
      decisions: [{ decision, answer: null }],
    });
    const outcome = await askPerson(triageOf(task, duplicateSummary));
    assert.deepEqual(methods(bridge.requests), ["waitForDecision", "label"]);
    assert.deepEqual(payloads(bridge.requests, "label"), [
      { number: 639, add: ["cloving: triaged"], remove: [] },
    ]);
    assert.deepEqual(outcome, {
      kind: "handoff_requested",
      cycleId: issue.cycleId,
      promotionId: "triage-639",
      report:
        "Triage of #639: duplicate #599. The reply is not approved, so only cloving: triaged is added.",
    });
  }
});

await test("CLV-319 Post at once posts the reply and adds the labels without a decision", async () => {
  using bridge = fakeStepBridge({ effects: triageEffects(duplicateSummary) });
  await postAtOnce(triageOf(task, duplicateSummary));
  assert.deepEqual(methods(bridge.requests), ["comment-issue", "label"]);
  assert.deepEqual(payloads(bridge.requests, "label"), [
    {
      number: 639,
      add: ["cloving: triaged", "cloving: duplicate"],
      remove: [],
    },
  ]);
});

await test("CLV-319 a reply with a local path is refused and the run ends blocked with the privacy reason", async () => {
  using bridge = fakeStepBridge({
    effects: triageEffects(
      "The log is at /opt/private/run.log.\nTriage: needs-information",
      failed("private-path-in-change"),
    ),
    decisions: approvals("approved"),
  });
  const outcome = await triageIssue(issue);
  assert.deepEqual(outcome, {
    kind: "blocked",
    cycleId: issue.cycleId,
    evidenceId: "triage-issue",
    reason: "private-path-in-change",
  });
  assert.deepEqual(
    methods(bridge.requests),
    ["prepare", "run-turn", "discard"].concat(asked(), [
      "comment-issue",
      "label",
    ]),
  );
  assert.deepEqual(payloads(bridge.requests, "label"), [
    { number: 639, add: ["cloving: triaged"], remove: [] },
  ]);
});

await test("CLV-319 a post that fails for another reason adds no label and blocks the run", async () => {
  using bridge = fakeStepBridge({
    effects: triageEffects(duplicateSummary, failed("github-network-failed")),
    decisions: approvals("approved"),
  });
  assert.deepEqual(await triageIssue(issue), {
    kind: "blocked",
    cycleId: issue.cycleId,
    evidenceId: "triage-issue",
    reason: "github-network-failed",
  });
  assert.deepEqual(
    methods(bridge.requests),
    ["prepare", "run-turn", "discard"].concat(asked(), ["comment-issue"]),
  );
});

await test("CLV-319 a turn without one valid verdict line or without a reply blocks the run before any post", async () => {
  for (const [summary, reason] of [
    ["The issue is a bug.", "invalid-triage-verdict"],
    ["Reason.\nTriage: bug huge", "invalid-triage-verdict"],
    ["Reason.\nTriage: duplicate", "invalid-triage-verdict"],
    ["Same issue.\nTriage: duplicate #639", "invalid-triage-verdict"],
    ["Triage: bug small", "triage-reply-missing"],
    ["\n\nTriage: feature large\n", "triage-reply-missing"],
  ] as const) {
    using bridge = fakeStepBridge({ effects: triageEffects(summary) });
    assert.deepEqual(await triageIssue(issue), {
      kind: "blocked",
      cycleId: issue.cycleId,
      evidenceId: "triage-issue",
      reason,
    });
    assert.deepEqual(methods(bridge.requests), [
      "prepare",
      "run-turn",
      "discard",
    ]);
  }
});

await test("CLV-319 one pass hands off four of six candidates and a pass without candidates hands off none", async () => {
  {
    using bridge = fakeStepBridge({
      effects: candidates([1, 2, 3, 4, 5, 6].map((number) => ({ number }))),
    });
    await triageIssue(pass);
    assert.deepEqual(
      bridge.requests.flatMap((request) =>
        request[0] === "handoff" ? [request[1].input["issue"]] : [],
      ),
      [1, 2, 3, 4],
    );
  }
  using bridge = fakeStepBridge({ effects: candidates([]) });
  assert.deepEqual(await triageIssue(pass), {
    kind: "handoff_requested",
    cycleId: pass.cycleId,
    promotionId: "triage-pass",
    report: "Triage candidates: 0. Runs: none.",
  });
  assert.deepEqual(methods(bridge.requests), ["run:triage-candidates"]);
});

await test("CLV-319 a failed or invalid candidates answer blocks the pass before any handoff", async () => {
  for (const [result, reason] of [
    [failed("command-exit"), "command-exit"],
    [{ kind: "stopped", operationId: "status", reason: null }, "stopped"],
    [{ ...completed(null), result: null }, "invalid-triage-candidates"],
    [completed({ issues: [] }), "invalid-triage-candidates"],
    [{ ...completed(null), result: "not json" }, "invalid-triage-candidates"],
    [completed([{ number: 0 }]), "invalid-triage-candidates"],
    [completed([639]), "invalid-triage-candidates"],
    [
      completed([{ number: 639 }, { number: 639 }]),
      "invalid-triage-candidates",
    ],
  ] as const) {
    using bridge = fakeStepBridge({
      effects: { "command run:triage-candidates": [result] },
    });
    assert.deepEqual(await triageIssue(pass), {
      kind: "blocked",
      cycleId: pass.cycleId,
      evidenceId: "triage-issue",
      reason,
    });
    assert.deepEqual(methods(bridge.requests), ["run:triage-candidates"]);
  }
});

await test("CLV-319 a failed prepare, a failed turn or a turn report without a summary blocks the run and discards the work tree", async () => {
  for (const [effects, reason, called] of [
    [
      Object.assign(triageEffects(duplicateSummary), {
        "github prepare": [failed("work-tree-not-available")],
      }),
      "work-tree-not-available",
      ["prepare", "discard"],
    ],
    [
      Object.assign(triageEffects(duplicateSummary), {
        "claude run-turn": [failed("turn-failed")],
      }),
      "turn-failed",
      ["prepare", "run-turn", "discard"],
    ],
    [
      Object.assign(triageEffects(duplicateSummary), {
        "claude run-turn": [completed({ result: "no summary" })],
      }),
      "invalid-triage-report",
      ["prepare", "run-turn", "discard"],
    ],
    [
      Object.assign(triageEffects(duplicateSummary), {
        "claude run-turn": [{ ...completed(null), result: "{" }],
      }),
      "triage-failed",
      ["prepare", "run-turn", "discard"],
    ],
  ] as const) {
    using bridge = fakeStepBridge({ effects });
    assert.deepEqual(await triageIssue(issue), {
      kind: "blocked",
      cycleId: issue.cycleId,
      evidenceId: "triage-issue",
      reason,
    });
    assert.deepEqual(methods(bridge.requests), called);
  }
});
