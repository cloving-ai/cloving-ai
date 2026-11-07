import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeStepBridge } from "cloving/workflows/testing";
import { goalToTickets } from "./goal-to-tickets.ts";
import {
  approved,
  chain,
  completed,
  cycle,
  effectRequests,
  effects,
  input,
  planText,
  postedTexts,
} from "./goal-to-tickets/scenarios.ts";

await test("CLV-302 a three-draft plan posts each ticket after its blocker with the real number", async () => {
  using bridge = fakeStepBridge({
    effects: effects([chain, chain]),
    decisions: approved,
    effectLimit: 32,
  });
  const outcome = await goalToTickets(input);
  assert.equal(outcome.kind, "handoff_requested");
  assert.equal(
    "promotionId" in outcome ? outcome.promotionId : null,
    "issues-101-102-103",
  );
  const posted = postedTexts(bridge.requests);
  assert.deepEqual(
    posted.map((text) => text.split("\n", 1).join("")),
    ["# Step 1", "# Step 2", "# Step 3"],
  );
  assert.match(String(posted[0]), /^## Dependencies\n\nNone\.$/m);
  assert.match(String(posted[1]), /^Needs #101$/m);
  assert.match(String(posted[2]), /^Needs #102$/m);
  assert.doesNotMatch(posted.join("\n"), /draft \d/i);
});

await test("CLV-302 a draft with a lower number than its blocker posts after the blocker", async () => {
  const reversed = planText([[2], []]);
  using bridge = fakeStepBridge({
    effects: effects([reversed, reversed]),
    decisions: approved,
  });
  assert.equal((await goalToTickets(input)).kind, "handoff_requested");
  const posted = postedTexts(bridge.requests);
  assert.deepEqual(
    posted.map((text) => text.split("\n", 1).join("")),
    ["# Step 2", "# Step 1"],
  );
  assert.match(String(posted[1]), /^Needs #101$/m);
});

await test("CLV-302 a plan with a cycle goes back to the research turn once", async () => {
  using bridge = fakeStepBridge({
    effects: effects([cycle, chain, chain]),
    decisions: approved,
  });
  assert.equal((await goalToTickets(input)).kind, "handoff_requested");
  const research = effectRequests(bridge.requests, "run-turn").filter(
    (request) => request.scope.operation === "research",
  );
  assert.deepEqual(
    research.map((request) => request.scope.round),
    [1, 2],
  );
  assert.match(
    String(research[1]?.payload),
    /dependency cycle: draft 1 -> draft 2 -> draft 1/,
  );
  assert.equal(postedTexts(bridge.requests).length, 3);
});

await test("CLV-302 a second cycle ends the run blocked and posts nothing", async () => {
  using bridge = fakeStepBridge({
    effects: effects([cycle, cycle, chain]),
    decisions: approved,
  });
  assert.deepEqual(await goalToTickets(input), {
    kind: "blocked",
    cycleId: input.cycleId,
    evidenceId: "goal-to-tickets",
    reason: "plan-cycle",
  });
  assert.equal(effectRequests(bridge.requests, "run-turn").length, 2);
  assert.deepEqual(postedTexts(bridge.requests), []);
  assert.ok(
    bridge.requests.every((request) => request[0] !== "waitForDecision"),
  );
});

await test("CLV-302 a plan file without drafts ends the run blocked before a post", async () => {
  using bridge = fakeStepBridge({
    effects: effects(["Some notes.\n", chain]),
    decisions: approved,
  });
  assert.deepEqual(await goalToTickets(input), {
    kind: "blocked",
    cycleId: input.cycleId,
    evidenceId: "goal-to-tickets",
    reason: "invalid-plan",
  });
  assert.equal(effectRequests(bridge.requests, "run-turn").length, 1);
  assert.deepEqual(postedTexts(bridge.requests), []);
});

await test("CLV-302 a plan of 12 tickets after one cycle stays within the effect limit", async () => {
  const twelve = planText(Array.from({ length: 12 }, () => []));
  using bridge = fakeStepBridge({
    effects: effects([cycle, twelve, twelve]),
    decisions: approved,
    effectLimit: 32,
  });
  assert.equal((await goalToTickets(input)).kind, "handoff_requested");
  assert.equal(postedTexts(bridge.requests).length, 12);
  assert.ok(bridge.spent <= 32);
});

for (const [name, change, reason] of [
  [
    "a plan read with a bad digest",
    {
      "github capture-draft": [completed({ text: chain, digest: "sha256:0" })],
    },
    "invalid-plan-capture",
  ],
  [
    "an issue result without a number",
    {
      "github create-issue": [
        completed({ url: "https://github.com/acme/demo/issues/1" }),
      ],
    },
    "invalid-github-result",
  ],
] as const)
  await test(`CLV-302 ${name} ends the run blocked`, async () => {
    using bridge = fakeStepBridge({
      effects: Object.assign(effects([chain, chain]), change),
      decisions: approved,
    });
    const outcome = await goalToTickets(input);
    assert.equal("reason" in outcome ? outcome.reason : null, reason);
    assert.ok(postedTexts(bridge.requests).length <= 1);
  });
