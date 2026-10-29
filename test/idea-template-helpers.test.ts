import assert from "node:assert/strict";
import { test } from "node:test";
import { runScenario } from "../src/testing.ts";
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

await test("CLV-222 serialized failures preserve safe broker reasons and refuse unstructured text", async () => {
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
    const result = await runScenario({
      workflow: helper("effects"),
      exportName: "failureReason",
      input: failure,
      decision: "fallback",
    });
    assert.equal(result.outcome, expected);
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
    for (const [module, exportName, reason] of [
      ["review", "reviewDraftByPerson", "draft-review-denied"],
      ["post-person", "postByPerson", "post-not-approved"],
    ])
      await assert.rejects(
        runScenario({
          workflow: helper(String(module)),
          exportName: String(exportName),
          input,
          decision: [],
          effects: effects(),
          decisions: [{ decision, answer: null }],
        }),
        new RegExp(String(reason)),
      );
  });

await test("CLV-222 a post approval preserves both the earlier review and latest capture digests", async () => {
  const earlier = `sha256:${"b".repeat(64)}`;
  const result = await runScenario({
    workflow: helper("post-person"),
    exportName: "postByPerson",
    input,
    decision: [earlier],
    effects: effects(),
    decisions: [{ decision: "approved", answer: null }],
  });
  assert.deepEqual(result.outcome, {
    number: 42,
    owner: "acme",
    repository: "demo",
  });
  const post = result.requests[2];
  assert.ok(post && post[0] === "effect");
  assert.deepEqual(JSON.parse(post[1].payload), {
    draft: "cloving-prd-draft.md",
    expectedDigests: [earlier, digest],
  });
});

await test("CLV-222 leaving an issue alone uses no effect or handoff", async () => {
  const result = await runScenario({
    workflow: helper("leave"),
    exportName: "leaveIssue",
    input,
    decision: { number: 42, owner: "acme", repository: "demo" },
  });
  assert.deepEqual(result.outcome, {
    kind: "handoff_requested",
    cycleId: input.cycleId,
    promotionId: "issue-42",
  });
  assert.deepEqual(result.requests, []);
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
