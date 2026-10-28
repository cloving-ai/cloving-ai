import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { fakeStepBridge, runScenario } from "../src/testing.ts";
import { reviewByAgent } from "../src/steps/review-by-agent.ts";
import { reviewByPerson } from "../src/steps/review-by-person.ts";
import { withFiles } from "./quality/files-fixture.ts";

const commit = "a".repeat(40);
const subject = { target: "ticket-1", commit, number: 42 };

await test("CLV-220 Greptile review returns the common review result through the fake bridge", () =>
  withFiles(
    {
      "review.mjs": `import { reviewByAgent } from "cloving/workflows/steps/review-by-agent";
export async function review(subject) {
  return await reviewByAgent({ subject, reviewer: { kind: "greptile" } });
}`,
    },
    async (root) => {
      const result = await runScenario({
        workflow: join(root, "review.mjs"),
        exportName: "review",
        input: subject,
        effects: {
          "github wait-review": [
            {
              kind: "completed",
              operationId: "review",
              receipt: null,
              result: JSON.stringify({
                number: 42,
                commit,
                score: 5,
                summary: "Ready.",
                findings: [],
              }),
            },
          ],
        },
      });
      assert.partialDeepStrictEqual(result.outcome, {
        accepted: true,
        feedback: "Ready.",
        commit,
      });
      assert.equal(result.requests.length, 1);
      const request = result.requests[0];
      assert.ok(request?.[0] === "effect");
      assert.equal(request[1].capability, "github");
      assert.equal(request[1].method, "wait-review");
      assert.equal(request[1].target, subject.target);
      assert.deepEqual(JSON.parse(request[1].payload), { number: 42, commit });
    },
  ));

function reviewed(result: unknown) {
  return {
    kind: "completed" as const,
    operationId: "review",
    receipt: null,
    result: JSON.stringify(result),
  };
}

await test("CLV-220 Greptile changes preserve findings and the person review subject identity", async () => {
  using bridge = fakeStepBridge({
    effects: {
      "github wait-review": [
        reviewed({
          number: 42,
          commit,
          score: 4,
          summary: "Fix the race.",
          findings: [
            { path: "src/task.ts", line: 12, body: "Await completion." },
          ],
        }),
      ],
    },
    decisions: [
      {
        decision: "denied",
        answer: "Fix the race.\n\nsrc/task.ts:12\nAwait completion.",
      },
    ],
  });
  const agent = await reviewByAgent({
    subject,
    reviewer: { kind: "greptile" },
  });
  assert.deepEqual(agent, await reviewByPerson({ subject }));
  assert.equal(agent.accepted, false);
  assert.equal(bridge.requests.length, 2);
});

for (const result of [
  null,
  { number: 42, commit, score: 5, summary: "Ready." },
  { number: 43, commit, score: 5, summary: "Ready.", findings: [] },
  {
    number: 42,
    commit: "b".repeat(40),
    score: 5,
    summary: "Ready.",
    findings: [],
  },
  { number: 42, commit, score: 6, summary: "Ready.", findings: [] },
  { number: 42, commit, score: 5, summary: "Ready.", findings: [null] },
])
  await test(`CLV-220 rejects malformed or unrelated Greptile results ${JSON.stringify(result)}`, async () => {
    using bridge = fakeStepBridge({
      effects: { "github wait-review": [reviewed(result)] },
    });
    await assert.rejects(
      reviewByAgent({ subject, reviewer: { kind: "greptile" } }),
      {
        message: "invalid-review-result",
      },
    );
    assert.equal(bridge.requests.length, 1);
  });

for (const invalid of [
  { draft: "A draft." },
  { target: "ticket-1", commit },
  { ...subject, number: 0 },
  { ...subject, number: 1.5 },
])
  await test(`CLV-220 Greptile needs a pull number and immutable commit ${JSON.stringify(invalid)}`, async () => {
    using bridge = fakeStepBridge({});
    await assert.rejects(
      reviewByAgent({ subject: invalid, reviewer: { kind: "greptile" } }),
      {
        message: "invalid-greptile-subject",
      },
    );
    assert.deepEqual(bridge.requests, []);
  });

await test("CLV-220 a failed Greptile effect cannot accept the subject", async () => {
  using bridge = fakeStepBridge({
    effects: {
      "github wait-review": [
        {
          kind: "failed",
          operationId: "review",
          reason: "review-not-received",
        },
      ],
    },
  });
  await assert.rejects(
    reviewByAgent({ subject, reviewer: { kind: "greptile" } }),
    {
      message: "review-not-received",
    },
  );
  assert.equal(bridge.requests.length, 1);
});

await test("CLV-220 review snapshots cannot follow later caller mutations", async () => {
  const mutable = { ...subject };
  using bridge = fakeStepBridge({
    effects: {
      "github wait-review": [
        reviewed({ ...subject, score: 5, summary: "Ready.", findings: [] }),
      ],
    },
  });
  const pending = reviewByAgent({
    subject: mutable,
    reviewer: { kind: "greptile" },
  });
  mutable.commit = "b".repeat(40);
  const result = await pending;
  assert.equal(result.commit, commit);
  assert.equal(result.accepted, true);
  const request = bridge.requests[0];
  assert.ok(request?.[0] === "effect");
  assert.deepEqual(JSON.parse(request[1].payload), { number: 42, commit });
});

await test("CLV-220 an unsupported reviewer cannot silently run Greptile", () =>
  withFiles(
    {
      "review.mjs": `import { reviewByAgent } from "cloving/workflows/steps/review-by-agent";
export async function review(input) { return await reviewByAgent(input); }`,
    },
    async (root) => {
      await assert.rejects(
        runScenario({
          workflow: join(root, "review.mjs"),
          exportName: "review",
          input: { subject, reviewer: { kind: "turn", profile: "review" } },
          effects: {
            "github wait-review": [
              reviewed({
                ...subject,
                score: 5,
                summary: "Ready.",
                findings: [],
              }),
            ],
          },
        }),
        /invalid-reviewer/,
      );
    },
  ));
