import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeStepBridge } from "cloving/workflows/testing";
import { reviewChecks } from "./review-checks.ts";
import {
  busyFacts,
  comment,
  completed,
  effects,
  facts,
  input,
  issue,
  link,
  methods,
  payloads,
  prompts,
  recordedDecisions,
  refusals,
  suggestion,
  tickets,
} from "./review-checks/scenarios.ts";

const turnOnly = ["run:review-comments", "prepare", "run-turn", "discard"];

async function quiet(given: unknown, suggestions?: readonly unknown[]) {
  using bridge = fakeStepBridge({
    effects: effects(given, suggestions),
    effectLimit: 12,
  });
  assert.deepEqual(await reviewChecks(input), {
    kind: "handoff_requested",
    cycleId: input.cycleId,
    promotionId: "review-checks",
    report: "No group of review threads this week.",
  });
  return methods(bridge.requests);
}

await test("CLV-316 one group that passes, an accept and one handed off issue run", async () => {
  using bridge = fakeStepBridge({
    effects: effects(facts()),
    decisions: [{ decision: "answered", answer: "accept" }],
    effectLimit: 12,
  });
  assert.deepEqual(await reviewChecks(input), {
    kind: "handoff_requested",
    cycleId: input.cycleId,
    promotionId: "review-checks",
    report:
      "Suggestions: 1. Accepted: 1 (await-in-loop). Rejected: 0. Deferred: 0.",
  });
  assert.deepEqual(methods(bridge.requests), [
    "run:review-comments",
    "prepare",
    "run-turn",
    "discard",
    "waitForDecision",
    "handoff",
    "run:review-checks-record",
  ]);
  const [ticket = ""] = tickets(bridge.requests);
  assert.match(ticket, /^# Add the review check await-in-loop\n/);
  assert.ok(
    ticket.includes("https://github.com/acme/demo/pull/643#discussion_r3"),
  );
  assert.deepEqual(payloads(bridge.requests, "run:review-checks-record"), [
    {
      decisions: [
        {
          name: "await-in-loop",
          kind: "enable-rule",
          rule: "no-await-in-loop",
          shape: "A promise that a loop starts and never awaits.",
          decision: "accept",
          links: [
            "https://github.com/acme/demo/pull/641#discussion_r1",
            "https://github.com/acme/demo/pull/641#discussion_r2",
            "https://github.com/acme/demo/pull/643#discussion_r3",
          ],
        },
      ],
    },
  ]);
});

await test("CLV-316 an issue run creates one issue and adds the label cloving: check", async () => {
  using bridge = fakeStepBridge({
    effects: {
      "github create-issue": [issue(52)],
      "github label": [completed({ number: 52 })],
    },
    effectLimit: 12,
  });
  const text = "# Add the review check await-in-loop\n\n## Problem\n\nShape.";
  assert.deepEqual(
    await reviewChecks({ cycleId: "checks-2", input: { text } }),
    {
      kind: "handoff_requested",
      cycleId: "checks-2",
      promotionId: "issue-52",
      report: "Created the check issue #52.",
    },
  );
  assert.deepEqual(methods(bridge.requests), ["create-issue", "label"]);
  assert.deepEqual(payloads(bridge.requests, "create-issue"), [{ text }]);
  assert.deepEqual(payloads(bridge.requests, "label"), [
    { number: 52, add: ["cloving: check"], remove: [] },
  ]);
});

await test("CLV-316 an issue run with no issue number blocks before the label", async () => {
  using bridge = fakeStepBridge({
    effects: { "github create-issue": [completed({ number: 0 })] },
    effectLimit: 12,
  });
  const outcome = await reviewChecks({
    cycleId: "checks-3",
    input: { text: "# T" },
  });
  assert.equal(
    outcome.kind === "blocked" ? outcome.reason : "",
    "invalid-issue-result",
  );
  assert.deepEqual(methods(bridge.requests), ["create-issue"]);
});

await test("CLV-316 two threads of one shape, or three threads on one pull request, give no suggestion", async () => {
  const two = suggestion({ links: [link(641, 1), link(643, 3)] });
  assert.deepEqual(await quiet(facts(), [two]), turnOnly);
  const onePull = facts({
    comments: [
      comment(641, 1),
      comment(641, 2),
      comment(641, 3),
      comment(643, 4),
    ],
  });
  const same = suggestion({
    links: [link(641, 1), link(641, 2), link(641, 3)],
  });
  assert.deepEqual(await quiet(onePull, [same]), turnOnly);
  const unknown = suggestion({
    links: [link(641, 1), link(641, 2), link(650, 9)],
  });
  assert.deepEqual(await quiet(facts(), [unknown]), turnOnly);
});

await test("CLV-316 a shape that an enabled rule, a quality check or an open ticket already reports gives no suggestion", async () => {
  for (const given of [
    facts({ lintRules: { "no-await-in-loop": "warn" } }),
    facts({ qualityChecks: ["no-await-in-loop"] }),
    facts({
      openTickets: [
        {
          number: 700,
          title: "Add the review check await-in-loop",
          url: "https://github.com/acme/demo/issues/700",
          check: "await-in-loop",
        },
      ],
    }),
  ])
    assert.deepEqual(await quiet(given), turnOnly);
});

await test("CLV-316 a rejected shape never comes back and a deferred shape comes back only with a new thread", async () => {
  const earlier = (decision: string, links: readonly string[]) => ({
    name: "await-in-loop",
    shape: "A promise that a loop starts and never awaits.",
    decision,
    links,
  });
  const all = [link(641, 1), link(641, 2), link(643, 3)];
  for (const decision of ["reject", "defer", "accept"])
    assert.deepEqual(
      await quiet(facts({ decisions: [earlier(decision, all)] })),
      turnOnly,
    );
  const rejected = facts({ decisions: [earlier("reject", [link(600, 1)])] });
  assert.deepEqual(await quiet(rejected), turnOnly);
  using bridge = fakeStepBridge({
    effects: effects(facts({ decisions: [earlier("defer", all.slice(0, 2))] })),
    decisions: [{ decision: "answered", answer: "defer" }],
    effectLimit: 12,
  });
  const outcome = await reviewChecks(input);
  assert.ok(outcome.kind === "handoff_requested");
  assert.match(outcome.report ?? "", /Deferred: 1 \(await-in-loop\)\.$/);
  assert.equal(tickets(bridge.requests).length, 0);
});

await test("CLV-316 an accept for 2 of 3 suggestions hands off 2 issue runs and records 3 decisions", async () => {
  const three = ["first-shape", "second-shape", "third-shape"].map((name) =>
    suggestion({ name, rule: name }),
  );
  using bridge = fakeStepBridge({
    effects: effects(facts(), three),
    decisions: [{ decision: "answered", answer: "Accept, reject accept" }],
    effectLimit: 12,
  });
  const outcome = await reviewChecks(input);
  assert.ok(outcome.kind === "handoff_requested");
  assert.equal(
    outcome.report,
    "Suggestions: 3. Accepted: 2 (first-shape, third-shape). Rejected: 1 (second-shape). Deferred: 0.",
  );
  assert.deepEqual(
    tickets(bridge.requests).map((text) => text.split("\n")[0]),
    [
      "# Add the review check first-shape",
      "# Add the review check third-shape",
    ],
  );
  assert.deepEqual(recordedDecisions(bridge.requests), [
    "first-shape accept",
    "second-shape reject",
    "third-shape accept",
  ]);
});

await test("CLV-316 a quiet week ends completed with no turn or no decision", async () => {
  assert.deepEqual(await quiet(facts({ comments: [] })), [
    "run:review-comments",
  ]);
  assert.deepEqual(await quiet(facts({ comments: [comment(641, 1)] })), [
    "run:review-comments",
  ]);
  assert.deepEqual(await quiet(facts(), []), turnOnly);
});

await test("CLV-316 a bad answer, no answer, a bad turn result, bad facts or a bad record block the run", async () => {
  for (const [scene, reason, last] of refusals) {
    const given = "facts" in scene ? scene.facts : facts();
    const base = effects(
      given,
      "suggestions" in scene ? scene.suggestions : undefined,
    );
    using bridge = fakeStepBridge({
      effects: Object.assign({}, base, "effects" in scene ? scene.effects : {}),
      decisions:
        "decisions" in scene
          ? scene.decisions
          : [{ decision: "answered", answer: "accept" }],
      effectLimit: 12,
    });
    assert.deepEqual(await reviewChecks(input), {
      kind: "blocked",
      cycleId: input.cycleId,
      evidenceId: "review-checks",
      reason,
    });
    assert.equal(methods(bridge.requests).at(-1), last, reason);
  }
});

await test("CLV-316 the turn gets the rules and the facts, and the question lists each suggestion", async () => {
  using bridge = fakeStepBridge({
    effects: effects(facts(), [
      suggestion({ scope: "all", kind: "quality-check" }),
    ]),
    decisions: [{ decision: "answered", answer: "reject" }],
    effectLimit: 12,
  });
  await reviewChecks(input);
  const [turnPrompt = "", question = ""] = prompts(bridge.requests);
  assert.match(turnPrompt, /at least 3 comments on at least 2 pull requests/);
  assert.match(
    turnPrompt,
    /questions, praise, design choices, missing tests and typos in prose/,
  );
  assert.ok(turnPrompt.includes(JSON.stringify(facts().comments[0])));
  assert.match(question, /accept, reject or defer for each suggested check/);
  assert.ok(
    question.includes(
      "1. await-in-loop: add the new quality check `no-await-in-loop` for all code. Shape: A promise that a loop starts and never awaits. Hits on main: 4 (`npx eslint --rule 'no-await-in-loop: error' src`). Threads: https://github.com/acme/demo/pull/641#discussion_r1",
    ),
  );
  assert.deepEqual(tickets(bridge.requests), []);
});

await test("CLV-316 a busy week keeps the turn request within 65536 bytes with the first comments and the newest decisions", async () => {
  const busy = busyFacts();
  using bridge = fakeStepBridge({
    effects: effects(busy, [
      suggestion({ links: [link(641, 1), link(642, 2), link(641, 3)] }),
    ]),
    decisions: [{ decision: "answered", answer: "accept" }],
    effectLimit: 12,
  });
  const outcome = await reviewChecks(input);
  assert.ok(outcome.kind === "handoff_requested");
  assert.match(outcome.report ?? "", /Accepted: 1 \(await-in-loop\)/);
  const [turnPrompt = ""] = prompts(bridge.requests);
  assert.ok(Buffer.byteLength(turnPrompt) <= 65536);
  assert.ok(Buffer.byteLength(turnPrompt) > 60000);
  assert.ok(turnPrompt.includes(JSON.stringify(busy.comments[0])));
  assert.ok(!turnPrompt.includes(JSON.stringify(busy.comments[199])));
  assert.ok(turnPrompt.includes('"name":"shape-299"'));
  assert.ok(!turnPrompt.includes('"name":"shape-0"'));
  assert.equal(tickets(bridge.requests).length, 1);
});

await test("CLV-316 the ticket has the PRD form, the check line, the scope and the count command", async () => {
  using bridge = fakeStepBridge({
    effects: effects(facts(), [
      suggestion({
        scope: "all",
        kind: "new-rule",
        rule: "local/no-loop-promise",
      }),
    ]),
    decisions: [{ decision: "answered", answer: "accept" }],
    effectLimit: 12,
  });
  await reviewChecks(input);
  const [ticket = ""] = tickets(bridge.requests);
  assert.deepEqual(
    ticket.split("\n").filter((line) => line.startsWith("#")),
    [
      "# Add the review check await-in-loop",
      "## Problem",
      "## Desired outcome",
      "## Concrete scenario",
      "## Scope",
      "## Non-goals",
      "## Acceptance criteria",
      "## First tests",
    ],
  );
  for (const line of [
    "Check: await-in-loop",
    "1. add the new ESLint rule `local/no-loop-promise`.",
    "2. The check covers all code. Fix or suppress each of the 4 hits on main in the same change.",
    "3. Main has 4 hits now. The command `npx eslint --rule 'no-await-in-loop: error' src` counted them.",
    "- https://github.com/acme/demo/pull/641#discussion_r2",
  ])
    assert.ok(ticket.split("\n").includes(line), line);
});

await test("CLV-316 a link that is not in the facts is no new evidence for a deferred shape", async () => {
  const known = [link(641, 1), link(641, 2), link(643, 3)];
  const deferred = facts({
    decisions: [
      {
        name: "await-in-loop",
        shape: "Shape.",
        decision: "defer",
        links: known,
      },
    ],
  });
  const padded = suggestion({ links: known.concat(link(650, 9)) });
  assert.deepEqual(await quiet(deferred, [padded]), turnOnly);
});
