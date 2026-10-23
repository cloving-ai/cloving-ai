import assert from "node:assert/strict";
import { test } from "node:test";
import { field, ran } from "./develop-workflow-fixture.ts";
import {
  input,
  first,
  second,
  prepared,
  turned,
  merged,
  completed,
  pull,
  review,
  steps,
  payloadOf,
} from "./develop-issue-fixture.ts";

await test("CLV-163 failed CI starts a fix turn, instructs repairs of preexisting failures and reviews the new commit", async () => {
  const output = "quality_linux: Run quality: Failed assertion";
  const [line] = await ran([
    {
      input,
      effects: {
        "github prepare": [prepared],
        "github label": [completed({})],
        "github close-issue": [completed({})],
        "claude run-turn": [turned, turned],
        "github open-pr": [pull(first), pull(second)],
        "github wait-review": [review(first, 5), review(second, 5)],
        "github merge": [completed({ reason: "ci-failed", output }), merged],
      },
    },
  ]);
  const prompt = payloadOf(line, 6);
  assert.match(prompt, /Fix the failed CI checks/);
  assert.match(
    prompt,
    /including failures that the pull request did not cause/,
  );
  assert.match(prompt, /commit the fix/);
  assert.ok(prompt.includes(output));
  assert.deepEqual(
    steps(line)
      .slice(6, 10)
      .map((step) => [field(step, 3), field(step, 4)]),
    [
      ["claude-turn", 2],
      ["github-open-pr", 2],
      ["github-wait-review", 2],
      ["github-merge", 2],
    ],
  );
  assert.deepEqual(JSON.parse(payloadOf(line, 9)), {
    number: 7,
    commit: second,
  });
  assert.equal(field(field(line, "outcome"), "kind"), "handoff_requested");
});

await test("CLV-163 CI failures count against the existing three fix rounds", async () => {
  const commits = ["1", "2", "3", "4"].map((digit) => digit.repeat(40));
  const [line] = await ran([
    {
      input,
      effects: {
        "github prepare": [prepared],
        "github label": [completed({}), completed({})],
        "claude run-turn": commits.map(() => turned),
        "github open-pr": commits.map(pull),
        "github wait-review": commits.map((commit) => review(commit, 5)),
        "github merge": commits.map(() =>
          completed({ reason: "ci-failed", output: "quality failed" }),
        ),
      },
    },
  ]);
  const outcome = field(line, "outcome");
  assert.equal(field(outcome, "kind"), "blocked");
  assert.match(
    String(field(outcome, "reason")),
    /ci-failed in round 4.*at most 3 fix rounds/,
  );
  assert.equal(
    steps(line).filter((step) => field(step, 3) === "claude-turn").length,
    4,
  );
});

await test("CLV-163 a CI timeout blocks with its reason without starting a fix round", async () => {
  const output = "CI wait limit reached. Pending checks: quality_linux";
  const [line] = await ran([
    {
      input,
      effects: {
        "github prepare": [prepared],
        "github label": [completed({}), completed({})],
        "claude run-turn": [turned],
        "github open-pr": [pull(first)],
        "github wait-review": [review(first, 5)],
        "github merge": [completed({ reason: "ci-pending", output })],
      },
    },
  ]);
  const outcome = field(line, "outcome");
  assert.equal(field(outcome, "kind"), "blocked");
  assert.match(String(field(outcome, "reason")), /ci-pending/);
  assert.ok(String(field(outcome, "reason")).includes(output));
  assert.equal(field(outcome, "evidenceId"), "github-merge");
  assert.equal(
    steps(line).filter((step) => field(step, 3) === "claude-turn").length,
    1,
  );
});
