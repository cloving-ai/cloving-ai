import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeStepBridge } from "cloving/workflows/testing";
import { reviewDay } from "../templates/review-day/review-day.ts";
import {
  effectText,
  fields,
} from "../templates/review-day/review-day/facts.ts";
import { parseReport } from "../templates/review-day/review-day/report.ts";
import { enforceCritique } from "../templates/review-day/review-day/critique.ts";
import { postAfterPrivacy } from "../templates/review-day/review-day/post.ts";
import {
  completed,
  effects,
  report,
  proposal,
  input,
} from "../templates/review-day/review-day/scenarios.ts";

await test("CLV-200 proposal text always carries its stable loop into the ticket", () => {
  const parsed = parseReport({
    ...report,
    proposals: [{ ...proposal, text: "One measured change." }],
  });
  assert.equal(
    parsed.proposals[0]?.text,
    "Loop: merge\n\nOne measured change.",
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
