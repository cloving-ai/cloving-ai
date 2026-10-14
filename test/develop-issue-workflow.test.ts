import assert from "node:assert/strict";
import { test } from "node:test";
import { field, ran, request } from "./develop-workflow-fixture.ts";

const cycleId = "clv-063-1a2b3c4d";
const ticket = [
  "# CLV-063: Merge the work through a pull request",
  "",
  "GitHub issue: cloving-ai/cloving-ai#63 (open)",
  "",
  "The body of the issue.",
].join("\n");
const input = {
  cycleId,
  ticketId: "CLV-063",
  ticket,
  repository: "/repositories/cloving",
  delivery: "pull-request",
};
const url = "https://github.com/cloving-ai/cloving-ai/pull/7";
const first = "1".repeat(40);
const second = "2".repeat(40);
const about =
  "Greptile reviews the pull request, and Cloving merges it when the confidence score is 5/5.";

function completed(result: unknown): unknown {
  return {
    kind: "completed",
    operationId: "operation",
    receipt: "receipt",
    result: JSON.stringify(result),
  };
}

const prepared = completed({ branch: `cloving/${cycleId}`, base: "main" });
const turned = completed({ summary: "I made the change." });
const merged = completed({ number: 7, merged: "f".repeat(40) });

function pull(commit: string): unknown {
  return completed({ number: 7, url, commit });
}

function review(commit: string, score: number): unknown {
  const findings =
    score < 5 ? [{ path: "src/a.ts", line: 4, body: "Check the bound." }] : [];
  return completed({
    number: 7,
    commit,
    score,
    summary: `Confidence Score: ${String(score)}/5`,
    findings,
  });
}

function steps(line: unknown): readonly unknown[] {
  const requests = field(line, "requests");
  return Array.isArray(requests)
    ? requests.map((item: unknown) => {
        const effect = field(item, 1);
        const scope = field(effect, "scope");
        return [
          field(effect, "capability"),
          field(effect, "method"),
          field(scope, "phase"),
          field(scope, "operation"),
          field(scope, "round"),
          field(effect, "target"),
        ];
      })
    : [];
}

function payloadOf(line: unknown, index: number): string {
  return String(field(request(line, index), "payload"));
}

await test("CLV-063 the issue workflow prepares a work tree, asks for one turn, opens a pull request, waits for the review, and merges at the score 5/5", async () => {
  const [line] = await ran([
    {
      input,
      effects: {
        "github prepare": [prepared],
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
  });
  assert.deepEqual(steps(line), [
    ["github", "prepare", "pull-request", "github-prepare", 1, cycleId],
    ["claude", "run-turn", "implement", "claude-turn", 1, cycleId],
    ["github", "open-pr", "pull-request", "github-open-pr", 1, cycleId],
    ["github", "wait-review", "pull-request", "github-wait-review", 1, cycleId],
    ["github", "merge", "pull-request", "github-merge", 1, cycleId],
  ]);
  assert.equal(payloadOf(line, 0), "{}");
  const prompt = payloadOf(line, 1);
  assert.match(prompt, /^You work on one ticket of this repository\./);
  assert.match(
    prompt,
    /\nThe branch becomes a public pull request\. Do not write local file paths, such as the path of your home folder, in files or in commit messages\.\n/,
  );
  assert.ok(prompt.endsWith(`The text of the ticket CLV-063:\n\n${ticket}`));
  assert.deepEqual(JSON.parse(payloadOf(line, 2)), {
    title: "CLV-063: Merge the work through a pull request",
    body: `Closes cloving-ai/cloving-ai#63\n\nCloving made this change for the ticket CLV-063. ${about}`,
  });
  const reviewed = { number: 7, commit: first };
  assert.deepEqual(JSON.parse(payloadOf(line, 3)), reviewed);
  assert.deepEqual(JSON.parse(payloadOf(line, 4)), reviewed);
});

await test("CLV-063 the issue workflow sends a review under 5/5 back to the worker with the summary and the findings, then pushes and waits for the next review", async () => {
  const [line] = await ran([
    {
      input,
      effects: {
        "github prepare": [prepared],
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
      ["claude-turn", 1],
      ["github-open-pr", 1],
      ["github-wait-review", 1],
      ["claude-turn", 2],
      ["github-open-pr", 2],
      ["github-wait-review", 2],
      ["github-merge", 2],
    ],
  );
  const fix = payloadOf(line, 4);
  assert.ok(fix.startsWith(payloadOf(line, 1)));
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
  assert.deepEqual(JSON.parse(payloadOf(line, 6)), {
    number: 7,
    commit: second,
  });
  assert.deepEqual(JSON.parse(payloadOf(line, 7)), {
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
  assert.equal(steps(line).length, 13);
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
        "claude run-turn": [turned],
        "github open-pr": [failed("private-path-in-change")],
      },
    },
    { input, effects: { "github prepare": [failed(null)] } },
    {
      input,
      effects: {
        "github prepare": [prepared],
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
  assert.equal(steps(refusedPush).length, 3);
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
        "claude run-turn": [turned],
        "github open-pr": [failed()],
      },
    },
  ]);
  assert.deepEqual(JSON.parse(payloadOf(line, 2)), {
    title: "Cloving task task-abc",
    body: `Cloving made this change for this ticket. ${about}`,
  });
});

function failed(): unknown {
  return { kind: "failed", operationId: "operation", reason: null };
}
