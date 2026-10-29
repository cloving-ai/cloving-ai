import assert from "node:assert/strict";
import { test } from "node:test";
import { field, ran, request } from "./develop-workflow-fixture.ts";
import {
  completed,
  statusScenario,
  payloadOf,
  steps,
  first,
  second,
  pull,
  review,
  merged,
} from "./develop-issue-fixture.ts";

await test("CLV-123 merged issues use the preserved ticket status when the summary was shortened", async () => {
  for (const ticketStatus of [
    { kind: "complete" },
    { kind: "partial", remaining: ["Add recovery.", "Verify restart."] },
  ]) {
    const given = statusScenario("The shortened report.");
    const [line] = await ran([
      {
        ...given,
        effects: {
          ...given.effects,
          "claude run-turn": [
            completed({ summary: "The shortened report.", ticketStatus }),
          ],
        },
      },
    ]);
    assert.equal(
      field(field(line, "outcome"), "ticketStatus"),
      ticketStatus.kind,
    );
    assert.equal(
      field(steps(line).at(-1), 1),
      ticketStatus.kind === "complete" ? "close-issue" : "partial-issue",
    );
    assert.deepEqual(
      field(JSON.parse(payloadOf(line, 6)), "remaining"),
      ticketStatus.remaining,
    );
  }
});

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
  assert.match(String(body), /^Refs cloving-ai\/cloving-ai#63\n/);
  assert.doesNotMatch(String(body), /Closes/);
  const prompt = String(field(request(line, 2), "payload"));
  assert.match(
    prompt,
    /exactly one.*Ticket status: complete.*Ticket status: partial/,
  );
  assert.match(prompt, /Remaining:.*one item on each line/);
});

await test("CLV-146 the worker prompt allows blank lines around the remaining list", async () => {
  const [line] = await ran([statusScenario("Ticket status: complete")]);
  const prompt = String(field(request(line, 2), "payload"));
  assert.match(
    prompt,
    /Blank lines are allowed around and between list items\./,
  );
});

await test("CLV-123 pull request references keep the supplied issue repository", async () => {
  const given = statusScenario("Ticket status: complete");
  const [line] = await ran([
    {
      ...given,
      input: {
        ...given.input,
        ticket: given.input.ticket.replace(
          "cloving-ai/cloving-ai#63",
          "other/project#63",
        ),
      },
    },
  ]);
  assert.match(
    String(field(JSON.parse(payloadOf(line, 3)), "body")),
    /^Refs other\/project#63\n/,
  );
  assert.deepEqual(JSON.parse(payloadOf(line, 6)), {
    owner: "other",
    repository: "project",
    number: 63,
    pullRequest: 7,
  });
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

await test("CLV-123 review and merge fix turns retain remaining work and require reassessment before completion", async () => {
  for (const reason of ["review", "check-failed", "merge-conflict"]) {
    const given = statusScenario("Unused.");
    const [line] = await ran([
      {
        ...given,
        effects: {
          ...given.effects,
          "claude run-turn": [
            completed({
              summary: "Shortened report.",
              ticketStatus: {
                kind: "partial",
                remaining: ["Add recovery.", "Verify restart."],
              },
            }),
            completed({
              summary: "Remaining:\n- Verify restart.\nTicket status: partial",
            }),
            completed({
              summary: "Checked each remaining item.\nTicket status: complete",
            }),
          ],
          "github open-pr": [pull(first), pull(second), pull("3".repeat(40))],
          "github wait-review": [
            review(first, reason === "review" ? 3 : 5),
            review(second, 3),
            review("3".repeat(40), 5),
          ],
          "github merge":
            reason === "review"
              ? [merged]
              : [completed({ reason, output: "Fix the merged tree." }), merged],
        },
      },
    ]);
    const prompts = steps(line).flatMap((step, index) =>
      field(step, 1) === "run-turn" ? [payloadOf(line, index)] : [],
    );
    assert.ok(
      prompts[1]?.includes(
        "Remaining work from the previous worker report:\n- Add recovery.\n- Verify restart.",
      ),
    );
    assert.match(
      prompts[1] ?? "",
      /Reassess each remaining item before reporting Ticket status: complete\. Keep every unfinished item in the next Remaining: list\. Drop an item that is not work of the acceptance criteria of this ticket\./,
    );
    assert.ok(
      prompts[2]?.includes(
        "Remaining work from the previous worker report:\n- Verify restart.",
      ),
    );
    assert.ok(!prompts[2]?.includes("- Add recovery."));
    assert.equal(field(field(line, "outcome"), "ticketStatus"), "complete");
  }
});

await test("the worker prompt keeps fail-closed checks and operator steps out of the remaining list", async () => {
  const [line] = await ran([statusScenario("Ticket status: complete")]);
  const prompt = String(field(request(line, 2), "payload"));
  for (const sentence of [
    "List as remaining only work that the acceptance criteria of this ticket ask for.",
    "A check that the repository keeps fail-closed on purpose is not remaining work.",
    "A step that the ticket gives to the operator is not remaining work.",
  ])
    assert.ok(prompt.includes(sentence), sentence);
});
