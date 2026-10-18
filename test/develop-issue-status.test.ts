import assert from "node:assert/strict";
import { test } from "node:test";
import { field, ran, request } from "./develop-workflow-fixture.ts";
import { statusScenario, payloadOf, steps } from "./develop-issue-fixture.ts";

await test("CLV-123 a complete report merges before protected closure and cannot auto-close through the PR", async () => {
  const [line] = await ran([
    statusScenario("Checked.\nTicket status: complete"),
  ]);
  assert.deepEqual(
    steps(line).map((step) => field(step, 1)),
    [
      "prepare",
      "label",
      "run-turn",
      "open-pr",
      "wait-review",
      "merge",
      "close-issue",
    ],
  );
  assert.deepEqual(JSON.parse(payloadOf(line, 6)), {
    owner: "cloving-ai",
    repository: "cloving-ai",
    number: 63,
    pullRequest: 7,
  });
  assert.equal(field(field(line, "outcome"), "ticketStatus"), "complete");
  const body = field(JSON.parse(payloadOf(line, 3)), "body");
  assert.match(String(body), /^Refs #63\n/);
  assert.doesNotMatch(String(body), /Closes/);
  const prompt = String(field(request(line, 2), "payload"));
  assert.match(
    prompt,
    /exactly one.*Ticket status: complete.*Ticket status: partial/,
  );
  assert.match(prompt, /Remaining:.*one item on each line/);
});

await test("CLV-123 partial and unknown reports record remaining work after merge and never request closure", async () => {
  for (const [summary, remaining] of [
    [
      "Changed.\nRemaining:\n- Add recovery.\n- Verify restart.\nTicket status: partial",
      ["Add recovery.", "Verify restart."],
    ],
    ["No status", ["The worker report has no ticket status line."]],
  ] as const) {
    const [line] = await ran([statusScenario(summary)]);
    assert.equal(field(steps(line).at(-1), 1), "partial-issue");
    assert.deepEqual(JSON.parse(payloadOf(line, 6)), {
      owner: "cloving-ai",
      repository: "cloving-ai",
      number: 63,
      pullRequest: 7,
      remaining,
    });
    assert.equal(field(field(line, "outcome"), "ticketStatus"), "partial");
  }
});

await test("CLV-123 a failed post-merge issue write remains visible on the merged outcome", async () => {
  const given = statusScenario("Checked.\nTicket status: complete");
  for (const kind of ["failed", "refused", "unavailable"]) {
    const [line] = await ran([
      {
        ...given,
        effects: {
          ...given.effects,
          "github close-issue": [{ kind, reason: "github-call-failed" }],
        },
      },
    ]);
    assert.equal(field(field(line, "outcome"), "kind"), "handoff_requested");
    assert.equal(field(field(line, "outcome"), "issueUpdate"), "failed");
  }
});
