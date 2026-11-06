import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeStepBridge } from "cloving/workflows/testing";
import { patrol } from "./patrol.ts";
import { askPerson, pickAll } from "./patrol/pick.ts";
import { rescuePulls } from "./patrol/rescue.ts";
import { stuckPulls } from "./patrol/status.ts";
import {
  answers,
  asked,
  completed,
  handoffs,
  input,
  methods,
  status,
  stuck,
} from "./patrol/scenarios.ts";

await test("CLV-305 a stuck pull request with a merge conflict and no active run gets a rescue-pr handoff", async () => {
  using bridge = fakeStepBridge({
    effects: status([stuck(641)]),
    decisions: answers("1"),
  });
  const outcome = await patrol(input);
  assert.equal(outcome.kind, "handoff_requested");
  assert.deepEqual(
    methods(bridge.requests),
    ["run:patrol-status"].concat(asked(), ["handoff"]),
  );
  assert.deepEqual(handoffs(bridge.requests), [
    {
      workflowId: "rescue-pr",
      input: {
        pullRequest: 641,
        reason: "merge-conflict",
        issue: "acme/demo#627",
        ticketStatus: "complete",
      },
    },
  ]);
});

await test("CLV-305 Hand off at once gives a merge conflict to rescue-pr without a decision", async () => {
  using bridge = fakeStepBridge({ effects: status([stuck(641)]) });
  const pulls = await stuckPulls();
  await rescuePulls(await pickAll({ input: input, pulls: pulls }));
  assert.deepEqual(methods(bridge.requests), ["run:patrol-status", "handoff"]);
});

await test("CLV-305 a pull request with an active run, a person's branch or a finished run is never a candidate", async () => {
  using bridge = fakeStepBridge({
    effects: status([
      stuck(641, { active: true }),
      stuck(642, { branch: "feature/search" }),
      stuck(643, { state: "completed", reason: null, head: null }),
    ]),
    decisions: answers("all"),
  });
  const outcome = await patrol(input);
  assert.equal(outcome.kind, "handoff_requested");
  assert.deepEqual(methods(bridge.requests), ["run:patrol-status"]);
});

await test("CLV-305 one pass hands off four of six candidates", async () => {
  using bridge = fakeStepBridge({
    effects: status(
      [641, 642, 643, 644, 645, 646].map((number) => stuck(number)),
    ),
    decisions: answers("1, 2, 3, 4, 5, 6"),
  });
  await patrol(input);
  assert.deepEqual(
    handoffs(bridge.requests).map((request) => request.input["pullRequest"]),
    [641, 642, 643, 644],
  );
});

await test("CLV-305 Ask a person first hands off nothing before the decision", async () => {
  for (const decision of [
    { decision: "denied" as const, answer: "1" },
    { decision: "expired" as const, answer: "1" },
    { decision: "answered" as const, answer: "none" },
    { decision: "answered" as const, answer: "first" },
    { decision: "approved" as const, answer: null },
    { decision: "answered" as const, answer: "3" },
  ]) {
    using bridge = fakeStepBridge({
      effects: status([stuck(641), stuck(642, { state: "failed" })]),
      decisions: [decision],
    });
    const picked = await askPerson({ input: input, pulls: await stuckPulls() });
    await rescuePulls(picked);
    assert.deepEqual(methods(bridge.requests), [
      "run:patrol-status",
      "waitForDecision",
    ]);
  }
});

await test("CLV-305 the decision lists every candidate and the person picks the rescues", async () => {
  using bridge = fakeStepBridge({
    effects: status([stuck(641), stuck(642, { state: "failed", score: null })]),
    decisions: [{ decision: "answered", answer: "2" }],
  });
  const picked = await askPerson({ input: input, pulls: await stuckPulls() });
  await rescuePulls(picked);
  const prompt = bridge.requests.flatMap((request) =>
    request[0] === "waitForDecision" ? [request[1].prompt] : [],
  );
  assert.match(
    prompt.join(""),
    /1\. Pull request #641 on cloving\/task-000000000641: blocked \(merge-conflict\), head aaaaaaaaaaaa, review 4\/5\./,
  );
  assert.match(
    prompt.join(""),
    /2\. Pull request #642 .+: failed \(merge-conflict\), .+, no review score\./,
  );
  assert.deepEqual(
    handoffs(bridge.requests).map((request) => request.input["pullRequest"]),
    [642],
  );
});

await test("CLV-305 a failed or invalid patrol status blocks the pass before any handoff", async () => {
  for (const [result, reason] of [
    [
      {
        kind: "failed" as const,
        operationId: "status",
        reason: "command-exit",
      },
      "command-exit",
    ],
    [completed({ pulls: [] }), "invalid-patrol-status"],
    [
      {
        kind: "completed" as const,
        operationId: "status",
        receipt: null,
        result: "not json",
      },
      "invalid-patrol-status",
    ],
    [completed([stuck(641, { head: "HEAD" })]), "invalid-patrol-status"],
    [completed([stuck(641, { active: "no" })]), "invalid-patrol-status"],
    [completed([stuck(641, { issue: "#627" })]), "invalid-patrol-status"],
    [completed([stuck(641, { score: 6 })]), "invalid-patrol-status"],
  ] as const) {
    using bridge = fakeStepBridge({
      effects: { "command run:patrol-status": [result] },
    });
    assert.deepEqual(await patrol(input), {
      kind: "blocked",
      cycleId: input.cycleId,
      evidenceId: "patrol",
      reason,
    });
    assert.deepEqual(methods(bridge.requests), ["run:patrol-status"]);
  }
});
