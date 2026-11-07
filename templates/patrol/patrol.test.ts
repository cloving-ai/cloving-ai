import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeStepBridge } from "cloving/workflows/testing";
import { patrol } from "./patrol.ts";
import { askPerson, pickAll } from "./patrol/pick.ts";
import { rescuePulls } from "./patrol/rescue.ts";
import { patrolStatus } from "./patrol/status.ts";
import {
  answers,
  asked,
  completed,
  handoffs,
  input,
  methods,
  quiet,
  review,
  reviewThread,
  reviewed,
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
  const pulls = (await patrolStatus()).stuck;
  await rescuePulls(await pickAll({ input: input, pulls: pulls }));
  assert.deepEqual(methods(bridge.requests), ["run:patrol-status", "handoff"]);
});

await test("CLV-305 a pull request with an active run, a person's branch or a finished run is never a candidate", async () => {
  using bridge = fakeStepBridge({
    effects: Object.assign(
      status([
        stuck(641, { active: true }),
        stuck(642, { branch: "feature/search" }),
        quiet(643),
      ]),
      { "github review-threads": [review({ threads: [] })] },
    ),
    decisions: answers("all"),
  });
  const outcome = await patrol(input);
  assert.equal(outcome.kind, "handoff_requested");
  assert.deepEqual(methods(bridge.requests), [
    "run:patrol-status",
    "review-threads",
  ]);
});

await test("CLV-313 a quiet pull request with an open review thread and no active run gets an answer-review handoff", async () => {
  using bridge = fakeStepBridge({
    effects: Object.assign(status([stuck(641, { active: true }), quiet(643)]), {
      "github review-threads": [review()],
    }),
  });
  const outcome = await patrol(input);
  assert.equal(outcome.kind, "handoff_requested");
  assert.deepEqual(methods(bridge.requests), [
    "run:patrol-status",
    "review-threads",
    "handoff",
  ]);
  assert.deepEqual(reviewed(bridge.requests), [{ number: 643 }]);
  assert.deepEqual(handoffs(bridge.requests), [
    { workflowId: "answer-review", input: { pullRequest: 643 } },
  ]);
  assert.match(
    String(Reflect.get(outcome, "report")),
    /Review answers: #643\./,
  );
});

await test("CLV-313 a pull request with an active run, a comment in the last 5 minutes, answered comments or no open thread is not a review candidate", async () => {
  using bridge = fakeStepBridge({
    effects: Object.assign(
      status([
        quiet(643, { active: true }),
        quiet(644, { branch: "feature/search" }),
        quiet(645),
        quiet(646),
        quiet(647),
        quiet(648),
        quiet(649),
      ]),
      {
        "github review-threads": [
          review({ quietSeconds: 299 }),
          review({
            threads: [
              reviewThread({ id: "PRRT_1", answered: true }),
              reviewThread({ id: "PRRT_2", answered: true }),
            ],
          }),
          review({ threads: [], latest: null, quietSeconds: null }),
          {
            kind: "failed" as const,
            operationId: "r",
            reason: "pull-request-not-open",
          },
          completed("not a review"),
        ],
      },
    ),
  });
  const outcome = await patrol(input);
  assert.deepEqual(
    reviewed(bridge.requests)
      .map((value) => JSON.stringify(value))
      .sort(),
    [645, 646, 647, 648, 649].map((number) => JSON.stringify({ number })),
  );
  assert.deepEqual(handoffs(bridge.requests), []);
  assert.match(
    String(Reflect.get(outcome, "report")),
    /Review answers: none\./,
  );
});

await test("CLV-313 a pull request with one waiting thread among answered threads gets an answer-review handoff", async () => {
  using bridge = fakeStepBridge({
    effects: Object.assign(status([quiet(643)]), {
      "github review-threads": [
        review({
          threads: [
            reviewThread({ id: "PRRT_1", answered: false }),
            reviewThread({ id: "PRRT_2", answered: true }),
          ],
        }),
      ],
    }),
  });
  await patrol(input);
  assert.deepEqual(handoffs(bridge.requests), [
    { workflowId: "answer-review", input: { pullRequest: 643 } },
  ]);
});

await test("CLV-313 one pass reads at most eight pull requests and hands off at most four answers", async () => {
  const numbers = [651, 652, 653, 654, 655, 656, 657, 658, 659];
  const passes = [];
  for (const cycleId of numbers.map((number) => `patrol-${String(number)}`)) {
    using bridge = fakeStepBridge({
      effects: Object.assign(status(numbers.map((number) => quiet(number))), {
        "github review-threads": Array.from({ length: 8 }, () => review()),
      }),
    });
    await patrol({ cycleId, input: {} });
    const read = reviewed(bridge.requests).map((value) =>
      JSON.stringify(value),
    );
    const handed = handoffs(bridge.requests).map((request) =>
      JSON.stringify({ number: request.input["pullRequest"] }),
    );
    assert.equal(new Set(read).size, 8);
    assert.deepEqual(handed, read.slice(0, 4));
    passes.push(read);
  }
  assert.equal(new Set(passes.map((read) => read[0])).size, numbers.length);
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
    const picked = await askPerson({
      input: input,
      pulls: (await patrolStatus()).stuck,
    });
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
  const picked = await askPerson({
    input: input,
    pulls: (await patrolStatus()).stuck,
  });
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
