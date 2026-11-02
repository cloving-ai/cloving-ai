import assert from "node:assert/strict";
import { test } from "node:test";
import { runScenario, fakeStepBridge } from "../src/testing.ts";
import { failureReason } from "../templates/idea-to-issue/idea-to-issue/effects.ts";
import { reviewDraftByPerson } from "../templates/idea-to-issue/idea-to-issue/review.ts";
import { postByPerson } from "../templates/idea-to-issue/idea-to-issue/post-person.ts";
import { leaveIssue } from "../templates/idea-to-issue/idea-to-issue/leave.ts";
import {
  completed,
  digest,
  text,
  input,
  effects,
} from "../templates/idea-to-issue/idea-to-issue/scenarios.ts";

const helper = (name: string) =>
  new URL(
    `../templates/idea-to-issue/idea-to-issue/${name}.ts`,
    import.meta.url,
  ).href;

await test("CLV-222 serialized failures preserve safe broker reasons and refuse unstructured text", () => {
  for (const [failure, expected] of [
    [null, "fallback"],
    ["private detail", "fallback"],
    [{}, "fallback"],
    [{ message: 12 }, "fallback"],
    [{ message: "private detail" }, "fallback"],
    [{ message: "budget-exhausted" }, "budget-exhausted"],
    [{ cause: null }, "fallback"],
    [{ cause: { message: "handoff-start-timeout" } }, "handoff-start-timeout"],
  ] as const) {
    assert.equal(failureReason(failure, "fallback"), expected);
  }
});

await test("CLV-222 a broker failure without a reason stops before research", async () => {
  const result = await runScenario({
    workflow: new URL(
      "../templates/idea-to-issue/idea-to-issue.ts",
      import.meta.url,
    ).href,
    exportName: "ideaToIssue",
    input,
    effects: {
      ...effects(),
      "github prepare": [
        { kind: "failed", operationId: "prepare", reason: null },
      ],
    },
  });
  assert.deepEqual(result.outcome, {
    kind: "blocked",
    cycleId: input.cycleId,
    reason: "failed",
    evidenceId: "idea-to-issue",
  });
  assert.equal(result.requests.length, 1);
});

await test("CLV-222 a person review returns the protected digest and shows its exact text", async () => {
  const result = await runScenario({
    workflow: helper("review"),
    exportName: "reviewDraftByPerson",
    input,
    effects: effects(),
    decisions: [{ decision: "approved", answer: null }],
  });
  assert.deepEqual(result.outcome, [digest]);
  const gate = result.requests[1];
  assert.ok(gate && gate[0] === "waitForDecision");
  assert.equal(gate[1].prompt, `Review this subject:\n${text}`);
});

for (const decision of ["denied", "expired"] as const)
  await test(`CLV-222 the original person helpers refuse ${decision} decisions`, async () => {
    for (const [run, reason] of [
      [() => reviewDraftByPerson(input), "draft-review-denied"],
      [() => postByPerson(input, []), "post-not-approved"],
    ] as const) {
      using bridge = fakeStepBridge({
        effects: effects(),
        decisions: [{ decision, answer: null }],
      });
      await assert.rejects(run(), new RegExp(reason));
      assert.equal(bridge.requests[1]?.[0], "waitForDecision");
    }
  });

await test("CLV-222 a post approval preserves both the earlier review and latest capture digests", async () => {
  const earlier = `sha256:${"b".repeat(64)}`;
  using bridge = fakeStepBridge({
    effects: effects(),
    decisions: [{ decision: "approved", answer: null }],
  });
  assert.deepEqual(await postByPerson(input, [earlier]), {
    number: 42,
    owner: "acme",
    repository: "demo",
  });
  const post = bridge.requests[2];
  assert.ok(post && post[0] === "effect");
  assert.deepEqual(JSON.parse(post[1].payload), {
    draft: "cloving-prd-draft.md",
    expectedDigests: [earlier, digest],
  });
});

await test("CLV-222 leaving an issue alone uses no effect or handoff", async () => {
  using bridge = fakeStepBridge({});
  assert.deepEqual(
    await leaveIssue(input, { number: 42, owner: "acme", repository: "demo" }),
    {
      kind: "handoff_requested",
      cycleId: input.cycleId,
      promotionId: "issue-42",
    },
  );
  assert.deepEqual(bridge.requests, []);
});

await test("CLV-222 invalid protected captures never open a human gate", async () => {
  for (const result of [
    null,
    {},
    { text: "", digest },
    { text, digest: "short" },
    { text: 4, digest },
    { text, digest: null },
  ])
    await assert.rejects(
      runScenario({
        workflow: helper("review"),
        exportName: "reviewDraftByPerson",
        input,
        effects: { "github capture-draft": [completed(result)] },
      }),
      /invalid-(?:draft-capture|issue-result)/,
    );
});

await test("CLV-222 malformed issue replies stop delivery with a stable refusal", async () => {
  for (const result of [
    "not json",
    "null",
    "[]",
    "{}",
    JSON.stringify({ number: 42, url: "wrong" }),
    JSON.stringify({ number: 0, url: "https://github.com/acme/demo/issues/0" }),
  ]) {
    const scenario = effects();
    scenario["github create-issue"] = [{ ...completed(), result }];
    const ran = await runScenario({
      workflow: new URL(
        "../templates/idea-to-issue/idea-to-issue.ts",
        import.meta.url,
      ).href,
      exportName: "ideaToIssue",
      input,
      effects: scenario,
    });
    assert.deepEqual(ran.outcome, {
      kind: "blocked",
      cycleId: input.cycleId,
      reason: "invalid-issue-result",
      evidenceId: "idea-to-issue",
    });
    assert.equal(ran.requests.length, 4);
  }
});
