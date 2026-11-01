import assert from "node:assert/strict";
import { test } from "node:test";
import { field, ran, request } from "./develop-workflow-fixture.ts";

import {
  cycleId,
  ticket,
  input,
  url,
  first,
  second,
  about,
  prepared,
  turned,
  merged,
  completed,
  pull,
  review,
  steps,
  payloadOf,
} from "./develop-issue-fixture.ts";

await test("CLV-081 a failed merge check starts a fix turn and reviews the new commit before merging", async () => {
  const output = "Failed test: expected the merged tree to pass.";
  const [line] = await ran([
    {
      input,
      effects: {
        "github prepare": [prepared],
        "github close-issue": [completed({})],
        "github label": [completed({}), completed({})],
        "claude run-turn": [turned, turned],
        "github open-pr": [pull(first), pull(second)],
        "github wait-review": [review(first, 5), review(second, 5)],
        "github merge": [completed({ reason: "check-failed", output }), merged],
      },
    },
  ]);
  assert.deepEqual(
    steps(line).map((step) => [field(step, 3), field(step, 4)]),
    [
      ["github-prepare", 1],
      ["github-label", 1],
      ["claude-turn", 1],
      ["github-open-pr", 1],
      ["github-wait-review", 1],
      ["github-merge", 1],
      ["claude-turn", 2],
      ["github-open-pr", 2],
      ["github-wait-review", 2],
      ["github-merge", 2],
      ["github-close-issue", 2],
    ],
  );
  const prompt = payloadOf(line, 6);
  assert.ok(prompt.startsWith(payloadOf(line, 2)));
  assert.match(prompt, /check-failed/);
  assert.ok(prompt.includes(output));
  assert.match(prompt, /newest commit of the default branch/);
  assert.match(prompt, /[Ff]ix the cause.*commit/);
  assert.deepEqual(JSON.parse(payloadOf(line, 8)), {
    number: 7,
    commit: second,
  });
  assert.deepEqual(JSON.parse(payloadOf(line, 9)), {
    number: 7,
    commit: second,
  });
  assert.deepEqual(field(line, "outcome"), {
    kind: "handoff_requested",
    cycleId,
    promotionId: "pull-request-7",
    ticketStatus: "complete",
  });
});

await test("CLV-063 the issue workflow prepares a work tree, asks for one turn, opens a pull request, waits for the review, and merges at the score 5/5", async () => {
  const [line] = await ran([
    {
      input,
      effects: {
        "github prepare": [prepared],
        "github close-issue": [completed({})],
        "github label": [completed({}), completed({})],
        "claude run-turn": [turned],
        "github open-pr": [pull(first)],
        "github wait-review": [review(first, 5)],
        "github merge": [merged],
      },
    },
  ]);
  assert.deepEqual(field(line, "outcome"), {
    kind: "handoff_requested",
    cycleId,
    promotionId: "pull-request-7",
    ticketStatus: "complete",
  });
  assert.deepEqual(steps(line), [
    ["github", "prepare", "pull-request", "github-prepare", 1, cycleId],
    ["github", "label", "pull-request", "github-label", 1, cycleId],
    ["claude", "run-turn", "implement", "claude-turn", 1, cycleId],
    ["github", "open-pr", "pull-request", "github-open-pr", 1, cycleId],
    ["github", "wait-review", "pull-request", "github-wait-review", 1, cycleId],
    ["github", "merge", "pull-request", "github-merge", 1, cycleId],
    ["github", "close-issue", "pull-request", "github-close-issue", 1, cycleId],
  ]);
  assert.deepEqual(field(field(request(line, 1), "scope"), "key"), "start");
  assert.equal(payloadOf(line, 0), "{}");
  const prompt = payloadOf(line, 2);
  assert.match(prompt, /^You work on one ticket of this repository\./);
  assert.match(
    prompt,
    /\nThe branch becomes a public pull request\. Do not write local file paths, such as the path of your home folder, in files or in commit messages\.\n/,
  );
  assert.ok(prompt.endsWith(`The text of the ticket CLV-063:\n\n${ticket}`));
  assert.deepEqual(JSON.parse(payloadOf(line, 3)), {
    title: "CLV-063: Merge the work through a pull request",
    body: `Refs cloving-ai/cloving-ai#63\n\nCloving made this change for the ticket CLV-063. ${about}`,
  });
  const reviewed = { number: 7, commit: first };
  assert.deepEqual(JSON.parse(payloadOf(line, 4)), reviewed);
  assert.deepEqual(JSON.parse(payloadOf(line, 5)), reviewed);
});

await test("CLV-063 the issue workflow sends a review under 5/5 back to the worker with the summary and the findings, then pushes and waits for the next review", async () => {
  const [line] = await ran([
    {
      input,
      effects: {
        "github prepare": [prepared],
        "github close-issue": [completed({})],
        "github label": [completed({}), completed({})],
        "claude run-turn": [turned, turned],
        "github open-pr": [pull(first), pull(second)],
        "github wait-review": [review(first, 3), review(second, 5)],
        "github merge": [merged],
      },
    },
  ]);
  assert.equal(field(field(line, "outcome"), "kind"), "handoff_requested");
  assert.deepEqual(
    steps(line).map((step) => [field(step, 3), field(step, 4)]),
    [
      ["github-prepare", 1],
      ["github-label", 1],
      ["claude-turn", 1],
      ["github-open-pr", 1],
      ["github-wait-review", 1],
      ["claude-turn", 2],
      ["github-open-pr", 2],
      ["github-wait-review", 2],
      ["github-merge", 2],
      ["github-close-issue", 2],
    ],
  );
  const fix = payloadOf(line, 5);
  assert.ok(fix.startsWith(payloadOf(line, 2)));
  assert.ok(
    fix.endsWith(
      [
        "",
        `This is round 2. The branch has the commits of the earlier rounds. Greptile reviewed the pull request ${url} at the commit 1111111 and gave the confidence score 3/5. Fix each problem of the review, then commit the fixes. Cloving merges the pull request when the score is 5/5.`,
        "",
        "Summary of the review:",
        "",
        "Confidence Score: 3/5",
        "",
        "Findings on lines:",
        "",
        "- src/a.ts:4: Check the bound.",
      ].join("\n"),
    ),
  );
  assert.deepEqual(JSON.parse(payloadOf(line, 7)), {
    number: 7,
    commit: second,
  });
  assert.deepEqual(JSON.parse(payloadOf(line, 8)), {
    number: 7,
    commit: second,
  });
});

await test("CLV-063 the issue workflow stops after three fix rounds with no score of 5/5, and leaves the pull request open", async () => {
  const commits = ["1", "2", "3", "4"].map((digit) => digit.repeat(40));
  const [line] = await ran([
    {
      input,
      effects: {
        "github prepare": [prepared],
        "github close-issue": [completed({})],
        "github label": [completed({}), completed({})],
        "claude run-turn": commits.map(() => turned),
        "github open-pr": commits.map((commit) => pull(commit)),
        "github wait-review": commits.map((commit, index) =>
          review(commit, [2, 3, 4, 4][index] ?? 0),
        ),
        "github merge": [merged],
      },
    },
  ]);
  assert.deepEqual(field(line, "outcome"), {
    kind: "blocked",
    cycleId,
    reason: `Greptile gave the confidence score 4/5 in round 4, and a run has at most 3 fix rounds. The pull request stays open: ${url}`,
    evidenceId: "github-wait-review",
  });
  assert.equal(steps(line).length, 15);
  assert.deepEqual(JSON.parse(payloadOf(line, 14)), {
    owner: "cloving-ai",
    repository: "cloving-ai",
    number: 63,
    add: ["cloving: blocked"],
    remove: ["cloving: in progress"],
  });
  assert.deepEqual(field(request(line, 14), "scope"), {
    phase: "pull-request",
    operation: "github-label",
    round: 4,
    key: "blocked",
  });
  assert.ok(steps(line).every((step) => field(step, 1) !== "merge"));
});

await test("CLV-063 the issue workflow ends as blocked with the step and its reason when a step does not complete", async () => {
  const failed = (reason: string | null): unknown => ({
    kind: "failed",
    operationId: "operation",
    reason,
  });
  const [refusedPush, noTree, noBudget] = await ran([
    {
      input,
      effects: {
        "github prepare": [prepared],
        "github close-issue": [completed({})],
        "github label": [completed({}), completed({})],
        "claude run-turn": [turned],
        "github open-pr": [failed("private-path-in-change")],
      },
    },
    { input, effects: { "github prepare": [failed(null)] } },
    {
      input,
      effects: {
        "github prepare": [prepared],
        "github close-issue": [completed({})],
        "github label": [completed({}), completed({})],
        "claude run-turn": [{ kind: "refused", reason: "budget-exhausted" }],
      },
    },
  ]);
  assert.deepEqual(field(refusedPush, "outcome"), {
    kind: "blocked",
    cycleId,
    reason:
      "The step github-open-pr has the result failed (private-path-in-change).",
    evidenceId: "github-open-pr",
  });
  assert.equal(steps(refusedPush).length, 5);
  assert.deepEqual(
    [field(noTree, "outcome"), field(noBudget, "outcome")].map((outcome) => [
      field(outcome, "reason"),
      field(outcome, "evidenceId"),
    ]),
    [
      ["The step github-prepare has the result failed.", "github-prepare"],
      [
        "The step claude-turn has the result refused (budget-exhausted).",
        "claude-turn",
      ],
    ],
  );
});

await test("CLV-063 the issue workflow names a pull request for a task with no ticket after its cycle, and closes no issue", async () => {
  const task = {
    cycleId: "task-abc",
    ticket: "Fix the typo in the README.",
    repository: "/repositories/cloving",
    delivery: "pull-request",
  };
  const [line] = await ran([
    {
      input: task,
      effects: {
        "github prepare": [prepared],
        "github close-issue": [completed({})],
        "github label": [completed({}), completed({})],
        "claude run-turn": [turned],
        "github open-pr": [failed()],
      },
    },
  ]);
  assert.ok(steps(line).every((step) => field(step, 1) !== "label"));
  assert.deepEqual(JSON.parse(payloadOf(line, 2)), {
    title: "Cloving task task-abc",
    body: `Cloving made this change for this ticket. ${about}`,
  });
});

function failed(): unknown {
  return { kind: "failed", operationId: "operation", reason: null };
}

function mergeScenario(reasons: readonly string[]): unknown {
  const commits = ["1", "2", "3", "4"].map((digit) => digit.repeat(40));
  return {
    input,
    effectLimit: 20,
    effects: {
      "github prepare": [prepared],
      "github close-issue": [completed({})],
      "github label": [completed({}), completed({})],
      "claude run-turn": commits.map(() => turned),
      "github open-pr": commits.map((commit) => pull(commit)),
      "github wait-review": commits.map((commit) => review(commit, 5)),
      "github merge": [
        ...reasons.map((reason) =>
          completed({
            reason,
            output:
              "Another lane merged first.\nCONFLICT (content): Merge conflict in src/a.ts",
          }),
        ),
        merged,
      ],
    },
  };
}

await test("CLV-081 a merge conflict tells the next worker to merge the default branch and resolve conflicts", async () => {
  const [line] = await ran([mergeScenario(["merge-conflict"])]);
  const prompt = payloadOf(line, 6);
  assert.ok(prompt.startsWith(payloadOf(line, 2)));
  assert.match(prompt, /merge-conflict/);
  assert.match(prompt, /[Mm]erge the default branch of origin into the branch/);
  assert.match(prompt, /resolve each conflict.*run the tests.*commit/);
  assert.match(prompt, /src\/a\.ts/);
  assert.match(prompt, /Another lane merged first\.\nCONFLICT/);
  assert.equal(steps(line).length, 11);
  assert.equal(field(field(line, "outcome"), "kind"), "handoff_requested");
});

await test("CLV-081 exhausted merge fixes block with the reason and the open pull request", async () => {
  for (const reason of ["check-failed", "merge-conflict"]) {
    const [line] = await ran([
      mergeScenario(Array.from({ length: 4 }, () => reason)),
    ]);
    assert.deepEqual(field(line, "outcome"), {
      kind: "blocked",
      cycleId,
      reason: `The merge has the result ${reason} in round 4, and a run has at most 3 fix rounds. The pull request stays open: ${url}`,
      evidenceId: "github-merge",
    });
    assert.equal(steps(line).length, 19);
  }
});

await test("CLV-081 the registered effect budget permits a fourth merge after three failed attempts", async () => {
  const [line] = await ran([
    mergeScenario(["check-failed", "merge-conflict", "check-failed"]),
  ]);
  assert.equal(field(field(line, "outcome"), "kind"), "handoff_requested");
  assert.equal(field(line, "spent"), 19);
  assert.deepEqual(
    steps(line)
      .filter((step) => field(step, 1) === "merge")
      .map((step) => field(step, 4)),
    [1, 2, 3, 4],
  );
});
