import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeStepBridge } from "cloving/workflows/testing";
import { developTurn } from "./develop/turn.ts";

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
