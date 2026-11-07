import assert from "node:assert/strict";
import { test } from "node:test";
import { record } from "../src/protocol.ts";
import { goalScenario } from "./goal-template-fixture.ts";
import {
  chain,
  draftText,
  effectRequests,
  effects,
  planText,
  postedTexts,
} from "../templates/goal-to-tickets/goal-to-tickets/scenarios.ts";

const outside = draftText(4, []).replace("None.", "Needs #586");
const mixed = `${planText([[], [1], []])}\n${outside}`;

function labels(requests: Parameters<typeof effectRequests>[0]): unknown[] {
  return effectRequests(requests, "label").map((request): unknown =>
    JSON.parse(request.payload),
  );
}

function field(value: unknown, name: string): unknown {
  return record(value)?.[name];
}

function ready(number: number) {
  return { number: number, add: ["cloving: ready"], remove: [] };
}

await test("CLV-302 with Put the ready tickets in the queue, each ticket gets the ready label and the report names the tickets that wait for a blocker", async () => {
  const result = await goalScenario({
    selection: { review: "turn", next: "queue" },
    scenario: { effects: effects([mixed, mixed]) },
  });
  assert.equal(field(result.outcome, "kind"), "handoff_requested");
  assert.match(String(postedTexts(result.requests)[3]), /^Needs #586$/m);
  assert.deepEqual(labels(result.requests), [
    ready(101),
    ready(102),
    ready(103),
    ready(104),
  ]);
  assert.match(
    String(field(result.outcome, "report")),
    /^Put in the queue: #101, #102, #103, #104\. Waiting for a blocker: #102, #104\.$/m,
  );
  assert.ok(result.requests.every((request) => request[0] !== "handoff"));
});

await test("CLV-302 with Hand the first ready ticket to develop, one handoff starts develop on that ticket", async () => {
  const result = await goalScenario({
    selection: { review: "turn", next: "develop" },
    scenario: { effects: effects([chain, chain]) },
  });
  assert.equal(field(result.outcome, "kind"), "handoff_requested");
  const handoffs = result.requests.filter(
    (request) => request[0] === "handoff",
  );
  assert.deepEqual(
    handoffs.map((request) => request[1]),
    [{ workflowId: "develop", input: { ticket: "101" } }],
  );
  assert.deepEqual(labels(result.requests), []);
});

await test("CLV-302 a failed develop handoff puts the first ready ticket in the queue", async () => {
  const result = await goalScenario({
    selection: { review: "turn", next: "develop" },
    scenario: {
      effects: Object.assign(effects([chain, chain]), {
        handoff: [{ kind: "refused" as const, reason: "workflow-active" }],
      }),
    },
  });
  assert.equal(field(result.outcome, "reason"), "workflow-active");
  assert.deepEqual(labels(result.requests), [ready(101)]);
});

await test("CLV-302 with Do nothing, the posted tickets get no label and no handoff", async () => {
  const result = await goalScenario({
    selection: { review: "turn", next: "nothing" },
    scenario: { effects: effects([chain, chain]) },
  });
  assert.equal(field(result.outcome, "kind"), "handoff_requested");
  assert.equal(postedTexts(result.requests).length, 3);
  assert.deepEqual(labels(result.requests), []);
  assert.ok(result.requests.every((request) => request[0] !== "handoff"));
});

for (const decision of ["denied", "expired"] as const)
  await test(`CLV-302 with I read the plan, a ${decision} decision posts nothing`, async () => {
    const result = await goalScenario({
      selection: { review: "person", next: "queue" },
      scenario: {
        effects: effects([chain]),
        decisions: [{ decision: decision, answer: null }],
      },
    });
    assert.deepEqual(result.outcome, {
      kind: "blocked",
      cycleId: "goal-1",
      evidenceId: "goal-to-tickets",
      reason: "plan-not-approved",
    });
    const gates = result.requests.filter(
      (request) => request[0] === "waitForDecision",
    );
    assert.equal(gates.length, 1);
    const prompt = String(gates[0]?.[1].prompt);
    for (const line of [
      "Draft 1: Step 1. Dependencies: None.",
      "Draft 2: Step 2. Dependencies: Needs draft 1",
      "Draft 3: Step 3. Dependencies: Needs draft 2",
    ])
      assert.ok(prompt.includes(line), line);
    assert.ok(
      result.requests.every(
        (request) =>
          request[0] !== "effect" || request[1].scope.operation !== "review",
      ),
    );
    assert.deepEqual(postedTexts(result.requests), []);
  });
