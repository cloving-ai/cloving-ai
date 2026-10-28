import { flowTests } from "./develop/flow-tests.ts";
import { refusalTests } from "./develop/refusal-tests.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeStepBridge } from "cloving/workflows/testing";
import { developTurn } from "./develop/turn.ts";
import { reviewPartial } from "./develop/partial.ts";
import { queuePartial } from "./develop/queue-partial.ts";

for (const scenario of flowTests.concat(refusalTests))
  await test(scenario.name, scenario.run);

await test("CLV-221 invalid partial rounds never dispatch an effect or open a question", async () => {
  using bridge = fakeStepBridge({});
  for (const round of [0, -1, 1.5, 5, NaN, Infinity]) {
    const input = {
      cycleId: "run-1",
      round,
      issue: { owner: "acme", repository: "demo", number: 42 },
      pullRequest: 7,
      remaining: ["Test."],
    };
    await assert.rejects(queuePartial(input), {
      message: "invalid-development-round",
    });
    await assert.rejects(reviewPartial(input), {
      message: "invalid-development-round",
    });
  }
  assert.deepEqual(bridge.requests, []);
});

await test("CLV-221 partial questions use distinct rounds and stop after three fixes", async () => {
  using bridge = fakeStepBridge({
    decisions: [
      { decision: "answered", answer: "First fix." },
      { decision: "answered", answer: "Second fix." },
      { decision: "answered", answer: "Third fix." },
    ],
  });
  for (const round of [1, 2, 3]) {
    assert.equal(
      typeof (await reviewPartial({
        cycleId: "run-1",
        round,
        remaining: ["Test."],
      })),
      "string",
    );
  }
  assert.equal(
    await reviewPartial({
      cycleId: "run-1",
      round: 4,
      remaining: ["Test."],
    }),
    null,
  );
  assert.deepEqual(
    bridge.requests.map((request) => {
      assert.equal(request[0], "waitForDecision");
      return request[1].gateId;
    }),
    ["partial:run-1:1", "partial:run-1:2", "partial:run-1:3"],
  );
});

await test("CLV-221 partial work stops without an explicit nonempty answer", async () => {
  for (const decision of [
    { decision: "answered" as const, answer: " \n" },
    { decision: "answered" as const, answer: null },
    { decision: "denied" as const, answer: "Do not continue." },
    { decision: "expired" as const, answer: "Stale feedback." },
    { decision: "approved" as const, answer: "Unexpected approval." },
  ]) {
    using bridge = fakeStepBridge({ decisions: [decision] });
    assert.equal(
      await reviewPartial({ cycleId: "run-1", round: 2, remaining: ["Test."] }),
      null,
    );
    assert.equal(bridge.requests.length, 1);
    assert.equal(bridge.requests[0]?.[0], "waitForDecision");
  }
});

await test("CLV-221 a person chooses the next fix for partial work", async () => {
  using bridge = fakeStepBridge({
    decisions: [{ decision: "answered", answer: "  Add recovery first.\n" }],
  });
  const feedback = await reviewPartial({
    cycleId: "run-1",
    round: 1,
    remaining: ["Add recovery.", "Verify restart."],
  });
  assert.equal(feedback, "  Add recovery first.\n");
  assert.equal(bridge.requests.length, 1);
  const request = bridge.requests[0];
  assert.ok(request && request[0] === "waitForDecision");
  assert.equal(request[1].gateId, "partial:run-1:1");
  assert.equal(request[1].kind, "question");
  assert.match(request[1].prompt, /- Add recovery\.\n- Verify restart\./);
  assert.match(request[1].prompt, /empty answer to stop/);
});

await test("CLV-221 queued partial work records the merged pull request and remaining items", async () => {
  const completed = {
    kind: "completed" as const,
    operationId: "partial-update",
    receipt: null,
    result: JSON.stringify({ number: 42, ticketStatus: "partial" }),
  };
  using bridge = fakeStepBridge({
    effects: { "github partial-issue": [completed] },
  });
  const result = await queuePartial({
    cycleId: "run-1",
    round: 2,
    issue: { owner: "acme", repository: "demo", number: 42 },
    pullRequest: 7,
    remaining: ["Add recovery.", "Verify restart."],
  });
  assert.deepEqual(result, completed);
  assert.deepEqual(bridge.requests, [
    [
      "effect",
      {
        scope: {
          phase: "pull-request",
          operation: "github-partial-issue",
          round: 2,
        },
        capability: "github",
        method: "partial-issue",
        target: "run-1",
        units: 1,
        payload: JSON.stringify({
          owner: "acme",
          repository: "demo",
          number: 42,
          pullRequest: 7,
          remaining: ["Add recovery.", "Verify restart."],
        }),
      },
    ],
  ]);
});

await test("CLV-221 queued partial work preserves broker failures and budget refusals", async () => {
  const input = {
    cycleId: "run-1",
    round: 4,
    issue: { owner: "acme", repository: "demo", number: 42 },
    pullRequest: 7,
    remaining: ["Add recovery."],
  };
  for (const kind of [
    "failed",
    "stopped",
    "blocked",
    "cancelled",
    "refused",
    "unavailable",
  ] as const) {
    const failure = { kind, operationId: "update", reason: "update-failed" };
    using bridge = fakeStepBridge({
      effects: { "github partial-issue": [failure] },
    });
    assert.deepEqual(await queuePartial(input), failure);
    assert.equal(bridge.requests.length, 1);
  }
  using bridge = fakeStepBridge({ effectLimit: 0 });
  assert.deepEqual(await queuePartial(input), {
    kind: "refused",
    reason: "budget-exhausted",
  });
  assert.equal(bridge.spent, 0);
});

await test("CLV-221 the template develops a ticket through the public step bridge", async () => {
  const completed = {
    kind: "completed" as const,
    operationId: "turn-1",
    receipt: null,
    result: JSON.stringify({ summary: "Implemented the ticket." }),
  };
  using bridge = fakeStepBridge({ turn: completed });
  const result = await developTurn({
    cycleId: "run-1",
    repository: "main-checkout",
    ticket: "# Fix the counter\n\nPreserve its value after restart.",
    round: 1,
    feedback: null,
  });
  assert.deepEqual(result, completed);
  assert.equal(bridge.requests.length, 1);
  const request = bridge.requests[0];
  assert.ok(request && request[0] === "effect");
  assert.deepEqual(request[1].scope, {
    phase: "implement",
    operation: "claude-turn",
    round: 1,
  });
  assert.equal(request[1].capability, "claude");
  assert.equal(request[1].method, "run-turn");
  assert.equal(request[1].target, "run-1");
  assert.equal(request[1].units, 1);
  assert.match(request[1].payload, /Preserve its value after restart\./);
  assert.match(request[1].payload, /main-checkout/);
  assert.match(request[1].payload, /Do not push/);
});

await test("CLV-221 task text reaches the development turn without a ticket lookup", async () => {
  using bridge = fakeStepBridge({});
  await developTurn({
    cycleId: "text-run",
    repository: "main-checkout",
    prompt: "Add an export for the parser.",
    round: 1,
    feedback: null,
  });
  assert.equal(bridge.requests.length, 1);
  const request = bridge.requests[0];
  assert.ok(request && request[0] === "effect");
  assert.equal(request[1].method, "run-turn");
  assert.match(request[1].payload, /Add an export for the parser\./);
});

for (const reason of ["check-failed", "merge-conflict", "ci-failed"]) {
  await test(`CLV-221 a fix turn receives the full ${reason} output`, async () => {
    const output =
      "First diagnostic\n\n  expected: 4\n  actual: 3\nLast diagnostic\n";
    using bridge = fakeStepBridge({});
    await developTurn({
      cycleId: "run-1",
      repository: "main-checkout",
      ticket: "Fix the counter.",
      round: 2,
      feedback: { reason, output, remaining: ["Add the restart test."] },
    });
    const request = bridge.requests[0];
    assert.ok(request && request[0] === "effect");
    assert.equal(request[1].scope.round, 2);
    assert.match(request[1].payload, /Fix the counter\./);
    assert.ok(request[1].payload.includes(reason));
    assert.ok(request[1].payload.endsWith(output));
    assert.match(request[1].payload, /- Add the restart test\./);
    assert.match(request[1].payload, /round 2/);
  });
}

await test("CLV-221 invalid turn inputs never dispatch a worker", async () => {
  using bridge = fakeStepBridge({});
  const common = {
    cycleId: "run-1",
    repository: "main-checkout",
    round: 1,
    feedback: null,
  };
  for (const task of [
    {},
    { ticket: "" },
    { prompt: " \n" },
    { ticket: "Ticket", prompt: "Task" },
  ])
    await assert.rejects(developTurn({ ...common, ...task }), {
      message: "invalid-development-task",
    });
  for (const round of [0, -1, 1.5, 5, NaN, Infinity])
    await assert.rejects(developTurn({ ...common, ticket: "Ticket", round }), {
      message: "invalid-development-round",
    });
  assert.deepEqual(bridge.requests, []);
});

await test("CLV-221 the last allowed fix turn preserves a broker refusal", async () => {
  using bridge = fakeStepBridge({ effectLimit: 0 });
  const result = await developTurn({
    cycleId: "run-1",
    repository: "main-checkout",
    ticket: "Fix the counter.",
    round: 4,
    feedback: { reason: "check-failed", output: "", remaining: [] },
  });
  assert.deepEqual(result, { kind: "refused", reason: "budget-exhausted" });
  assert.equal(bridge.requests.length, 1);
  assert.equal(bridge.spent, 0);
});
