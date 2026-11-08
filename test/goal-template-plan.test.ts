import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkedPlan,
  planDrafts,
  ticketText,
} from "../templates/goal-to-tickets/goal-to-tickets/plan.ts";
import {
  draftText,
  planText,
} from "../templates/goal-to-tickets/goal-to-tickets/scenarios.ts";

await test("CLV-302 the plan parser refuses a plan that is not 1 to 12 numbered drafts", () => {
  for (const text of [
    "",
    "Notes.\n",
    "Intro\n# Draft 1: Step 1\n",
    "# Draft 2: Step 2\n",
    `${draftText(1, [])}${draftText(3, [])}`,
    planText(Array.from({ length: 13 }, () => [])),
    draftText(1, [2]),
  ])
    assert.throws(() => planDrafts(text), /^Error: invalid-plan$/, text);
  assert.equal(
    planDrafts(planText(Array.from({ length: 12 }, () => []))).length,
    12,
  );
});

await test("CLV-302 only draft references inside the Dependencies section are blockers", () => {
  const text = [
    "# Draft 1: Parser",
    "Read draft 2 for context.",
    "## Dependencies",
    "None.",
    "## Notes",
    "Needs draft 2 later.",
    "# Draft 2: Store",
    "## Dependencies",
    "Needs draft 1 and Draft 1. Needs #586.",
    "# Draft 3: Docs",
    "No dependency section.",
  ].join("\n");
  const drafts = planDrafts(text);
  assert.deepEqual(
    drafts.map((draft) => [
      draft.number,
      draft.title,
      draft.blockers,
      draft.outside,
    ]),
    [
      [1, "Parser", [], false],
      [2, "Store", [1], true],
      [3, "Docs", [], false],
    ],
  );
  assert.deepEqual(checkedPlan(draftText(1, [1])), {
    kind: "cycle",
    cycle: [1, 1],
  });
});

await test("CLV-302 the ticket text names the posted number of each blocker and keeps other text", () => {
  const [, store] = planDrafts(
    "# Draft 1: Parser\n# Draft 2: Store\n\n## Problem\nSee draft 1.\n\n## Dependencies\n\nNeeds draft 1\nNeeds Draft 1. Needs #586.\n\n",
  );
  assert.ok(store);
  assert.equal(
    ticketText(store, [{ draft: 1, number: 41, title: "Parser", ready: true }]),
    "# Store\n\n## Problem\nSee draft 1.\n\n## Dependencies\n\nNeeds #41\nNeeds #41. Needs #586.\n",
  );
  assert.match(ticketText(store, []), /^Needs draft 1$/m);
});
