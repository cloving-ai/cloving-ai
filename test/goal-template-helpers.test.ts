import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeStepBridge } from "../src/testing.ts";
import {
  effectResult,
  failureReason,
  resultFields,
  type Ticket,
} from "../templates/goal-to-tickets/goal-to-tickets/effects.ts";
import { reviewByPerson } from "../templates/goal-to-tickets/goal-to-tickets/person.ts";
import { handoffFirst } from "../templates/goal-to-tickets/goal-to-tickets/develop.ts";
import { leaveTickets } from "../templates/goal-to-tickets/goal-to-tickets/leave.ts";
import { queueReady } from "../templates/goal-to-tickets/goal-to-tickets/queue.ts";
import { checkedPlan } from "../templates/goal-to-tickets/goal-to-tickets/plan.ts";
import {
  chain,
  completed,
  digest,
  input,
} from "../templates/goal-to-tickets/goal-to-tickets/scenarios.ts";

function ticket(number: number, state: "ready" | "waiting"): Ticket {
  return {
    draft: number - 100,
    number,
    title: `Step ${String(number)}`,
    ready: state === "ready",
  };
}

const tickets = [
  ticket(101, "waiting"),
  ticket(102, "ready"),
  ticket(103, "ready"),
];

await test("CLV-302 failure reasons keep safe broker reasons, also from a serialized cause", () => {
  for (const [failure, expected] of [
    [new Error("plan-cycle"), "plan-cycle"],
    [new Error("Private detail"), "goal-to-tickets-failed"],
    [{ cause: { message: "workflow-active" } }, "workflow-active"],
    [{ cause: { message: 7 } }, "goal-to-tickets-failed"],
    [{ cause: null }, "goal-to-tickets-failed"],
    [null, "goal-to-tickets-failed"],
    ["plan-cycle", "goal-to-tickets-failed"],
  ] as const)
    assert.equal(failureReason(failure), expected);
});

function planned() {
  const check = checkedPlan(chain);
  assert.ok(check.kind === "plan");
  return { text: chain, digest: digest, order: check.order };
}

await test("CLV-302 an approval of the plan returns the plan that the person saw", async () => {
  using bridge = fakeStepBridge({
    decisions: [{ decision: "approved", answer: null }],
  });
  const plan = planned();
  assert.equal(await reviewByPerson(input, plan), plan);
  const gate = bridge.requests.at(0);
  assert.ok(gate?.[0] === "waitForDecision");
  assert.equal(gate[1].gateId, `plan:goal-1:${digest}`);
  assert.equal(gate[1].kind, "approval");
  assert.ok(gate[1].prompt.startsWith("Post these 3 tickets in this order?"));
  assert.ok(gate[1].prompt.endsWith(chain));
});

await test("CLV-302 develop gets the first ready ticket, and a plan with no ready ticket hands off nothing", async () => {
  using bridge = fakeStepBridge({ effects: {} });
  const outcome = await handoffFirst(input, tickets);
  assert.match(
    "report" in outcome ? outcome.report : "",
    /Handed #102 to develop\./,
  );
  const none = await handoffFirst(input, [ticket(101, "waiting")]);
  assert.match("report" in none ? none.report : "", /No ticket is ready\./);
  assert.deepEqual(
    bridge.requests.map((request) => request[0]),
    ["handoff"],
  );
});

await test("CLV-302 a failed handoff with a failed label reports the failed issue update", async () => {
  using bridge = fakeStepBridge({
    effects: {
      handoff: [{ kind: "refused", reason: "workflow-active" }],
      "github label": [
        { kind: "failed", operationId: "label", reason: "github-call-failed" },
      ],
    },
  });
  const outcome = await handoffFirst(input, tickets);
  assert.equal(outcome.kind, "handoff_requested");
  assert.equal("issueUpdate" in outcome ? outcome.issueUpdate : null, "failed");
  assert.equal("reason" in outcome ? outcome.reason : null, "workflow-active");
  assert.match(
    "report" in outcome ? outcome.report : "",
    /ready label is not added/,
  );
  assert.equal(bridge.requests.length, 2);
});

await test("CLV-302 Do nothing uses no effect", async () => {
  using bridge = fakeStepBridge({ effects: {} });
  const left = await leaveTickets(input, tickets);
  assert.deepEqual(left, {
    kind: "handoff_requested",
    cycleId: "goal-1",
    promotionId: "issues-101-102-103",
    report:
      "Posted 3 tickets:\n#101 Step 101\n#102 Step 102\n#103 Step 103\nThe tickets are left for a person.",
  });
  assert.deepEqual(bridge.requests, []);
});

await test("CLV-302 the queue labels a ticket that waits for a blocker, and a plan with no waiting ticket reports none", async () => {
  using bridge = fakeStepBridge({
    effects: { "github label": [completed({}), completed({})] },
  });
  const waiting = await queueReady(input, [ticket(101, "waiting")]);
  assert.match(
    "report" in waiting ? waiting.report : "",
    /Put in the queue: #101\. Waiting for a blocker: #101\.$/,
  );
  const free = await queueReady(input, [ticket(102, "ready")]);
  assert.match(
    "report" in free ? free.report : "",
    /Put in the queue: #102\. Waiting for a blocker: none\.$/,
  );
  assert.deepEqual(
    bridge.requests.map((request) => request[0]),
    ["effect", "effect"],
  );
});

await test("CLV-302 GitHub results that are not completed objects stop the run with a stable reason", () => {
  assert.throws(
    () => effectResult({ kind: "failed", operationId: "x", reason: null }),
    /^Error: failed$/,
  );
  assert.equal(effectResult(completed()), "null");
  assert.equal(
    effectResult({
      kind: "completed",
      operationId: "x",
      receipt: null,
      result: null,
    }),
    "null",
  );
  for (const text of ["{", "[]", "null", "7"])
    assert.throws(
      () => resultFields(text),
      /^Error: invalid-github-result$/,
      text,
    );
  assert.deepEqual(resultFields('{"number":4}'), { number: 4 });
});

await test("CLV-302 a denied plan throws plan-not-approved, and a draft with no dependency line shows none", async () => {
  using bridge = fakeStepBridge({
    decisions: [{ decision: "denied", answer: null }],
  });
  const check = checkedPlan("# Draft 1: Alone\n\n## Problem\nNo blocker.\n");
  assert.ok(check.kind === "plan");
  await assert.rejects(
    reviewByPerson(input, { text: "plan", digest: digest, order: check.order }),
    /^Error: plan-not-approved$/,
  );
  const gate = bridge.requests.at(0);
  assert.ok(gate?.[0] === "waitForDecision");
  assert.ok(gate[1].prompt.includes("Draft 1: Alone. Dependencies: none"));
});
