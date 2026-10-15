import assert from "node:assert/strict";
import { test } from "node:test";
import { checkSubmission } from "../src/submission.ts";

const contract = {
  maximumBytes: 65_536,
  fields: {
    prompt: { type: "string" },
    rounds: { type: "integer", minimum: 1, maximum: 10 },
    publish: { type: "boolean", optional: true },
  },
} as const;

await test("CLV-089 integer and boolean submissions retain their values", () => {
  const submission = { prompt: "Check the change.", rounds: 3, publish: false };
  assert.deepEqual(
    checkSubmission(contract, {
      workflowId: "review-run",
      submission,
      source: "input",
    }),
    {
      kind: "valid",
      normalized:
        '{"submission":{"prompt":"Check the change.","publish":false,"rounds":3},"workflowId":"review-run"}',
      submission,
    },
  );
});

await test("CLV-089 field rules reject missing, unknown and mistyped values", () => {
  for (const [submission, field] of [
    [{ prompt: "Check", rounds: "3" }, "rounds"],
    [{ prompt: "Check", rounds: 3, publish: "false" }, "publish"],
    [{ prompt: "Check" }, "rounds"],
    [{ prompt: "  ", rounds: 3 }, "prompt"],
    [{ prompt: "Check", rounds: 3, other: true }, "other"],
    [{ prompt: "Check", rounds: 0 }, "rounds"],
    [{ prompt: "Check", rounds: 11 }, "rounds"],
    [{ prompt: "Check", rounds: 1.5 }, "rounds"],
  ] as const) {
    assert.deepEqual(
      checkSubmission(contract, {
        workflowId: "review-run",
        submission,
        source: "input",
      }),
      {
        kind: "rejected",
        code: "invalid-submission",
        detail: `Field ${field} is not valid.`,
      },
    );
  }
});

await test("CLV-089 optional fields may be absent and legacy string contracts stay valid", () => {
  for (const submission of [
    { prompt: "Check", rounds: 1 },
    { prompt: "Check", rounds: 10, publish: true },
  ])
    assert.equal(
      checkSubmission(contract, {
        workflowId: "review-run",
        submission,
        source: "input",
      }).kind,
      "valid",
    );
  for (const field of ["ticket", "prompt"]) {
    const legacy = { maximumBytes: 64, fields: { [field]: "string" as const } };
    for (const value of ["", " ", 3, false, undefined])
      assert.deepEqual(
        checkSubmission(legacy, {
          workflowId: "develop",
          submission: { [field]: value },
          source: "input",
        }),
        {
          kind: "rejected",
          code: "invalid-submission",
          detail: `Field ${field} is not valid.`,
        },
      );
    assert.equal(
      checkSubmission(legacy, {
        workflowId: "develop",
        submission: { [field]: "task" },
        source: "input",
      }).kind,
      "valid",
    );
  }
});
