import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeStepBridge } from "cloving/workflows/testing";
import { answerReview } from "./answer-review.ts";
import { neverResolve, resolveAfterFix } from "./answer-review/resolve.ts";
import {
  completed,
  effects,
  failed,
  head,
  input,
  methods,
  payloads,
  prompts,
  pushedCommit,
  resolved,
  stepFailures,
  thread,
  threads,
} from "./answer-review/scenarios.ts";

const read = ["prepare", "review-threads", "record-answered", "run-turn"];

function reportOf(outcome: Awaited<ReturnType<typeof answerReview>>): string {
  return "report" in outcome ? outcome.report : outcome.kind;
}

await test("CLV-313 a fix of a bot thread posts one reply that names the commit and resolves the thread", async () => {
  using bridge = fakeStepBridge({
    effects: effects({
      threads: [thread("PRRT_1")],
      summary: "Fixed the bound.\nThread T1: fixed abc1234",
      commits: ["abc1234 Check the bound"],
    }),
  });
  const outcome = await answerReview(input);
  assert.equal(outcome.kind, "handoff_requested");
  assert.deepEqual(
    methods(bridge.requests),
    read.concat(["open-pr", "reply-thread"], resolved(["resolve-thread"]), [
      "wait-review",
    ]),
  );
  assert.deepEqual(payloads(bridge.requests, "reply-thread"), [
    { thread: "PRRT_1", body: "Fixed in abc1234." },
  ]);
  assert.deepEqual(
    payloads(bridge.requests, "resolve-thread"),
    resolved([{ thread: "PRRT_1" }]),
  );
  assert.deepEqual(payloads(bridge.requests, "wait-review"), [
    { number: 641, commit: pushedCommit },
  ]);
  assert.deepEqual(payloads(bridge.requests, "record-answered"), [
    { number: 641, comment: "C_last" },
  ]);
  assert.equal(
    reportOf(outcome),
    `Threads: T1 ${resolved(["resolved"]).at(0) ?? "open"}. Greptile review: 5/5.`,
  );
});

await test("CLV-313 a fixed line with a longer SHA matches the short commit of the turn", async () => {
  using bridge = fakeStepBridge({
    effects: effects({
      threads: [thread("PRRT_1", { bot: false })],
      summary: "Thread T1: fixed abc1234bbbb",
      commits: ["abc1234 Check the bound"],
    }),
  });
  assert.equal((await answerReview(input)).kind, "handoff_requested");
  assert.deepEqual(payloads(bridge.requests, "reply-thread"), [
    { thread: "PRRT_1", body: "Fixed in abc1234bbbb." },
  ]);
});

await test("CLV-313 a thread of a person gets a reply and stays open", async () => {
  using bridge = fakeStepBridge({
    effects: effects({
      threads: [thread("PRRT_2", { bot: false })],
      summary: "Thread T1: fixed abc1234",
      commits: ["abc1234 Rename the field"],
    }),
  });
  const outcome = await answerReview(input);
  assert.deepEqual(
    methods(bridge.requests),
    read.concat(["open-pr", "reply-thread", "wait-review"]),
  );
  assert.equal(reportOf(outcome), "Threads: T1 open. Greptile review: 5/5.");
});

await test("CLV-313 no change posts one reply with the reason and no commit", async () => {
  using bridge = fakeStepBridge({
    effects: effects({
      threads: [thread("PRRT_3")],
      summary:
        "Thread T1: no change The parser checks the bound.\nThread T1: fixed abc1234\nThread T9: no change Another thread.",
    }),
  });
  const outcome = await answerReview(input);
  assert.deepEqual(methods(bridge.requests), read.concat(["reply-thread"]));
  assert.deepEqual(payloads(bridge.requests, "reply-thread"), [
    {
      thread: "PRRT_3",
      body: "No change is needed: The parser checks the bound.",
    },
  ]);
  assert.equal(
    reportOf(outcome),
    "Threads: T1 open. No push, so no new review.",
  );
});

await test("CLV-313 a question opens a decision, and the reply has the person's answer", async () => {
  using bridge = fakeStepBridge({
    effects: effects({
      threads: [thread("PRRT_4", { bot: false }), thread("PRRT_5")],
      summary:
        "Thread T1: question Keep the old name for the release?\nThread T2: no change The test covers it.",
    }),
    decisions: [{ decision: "answered", answer: " Keep the old name. " }],
  });
  const outcome = await answerReview(input);
  assert.deepEqual(
    methods(bridge.requests),
    read.concat(["reply-thread", "waitForDecision", "reply-thread"]),
  );
  assert.deepEqual(payloads(bridge.requests, "reply-thread"), [
    { thread: "PRRT_5", body: "No change is needed: The test covers it." },
    { thread: "PRRT_4", body: "Keep the old name." },
  ]);
  const [prompt] = prompts(bridge.requests);
  assert.match(String(prompt), /Question: Keep the old name for the release\?/);
  assert.match(String(prompt), /Thread T1 on src\/a\.ts line 3 \(person\):/);
  assert.equal(
    reportOf(outcome),
    "Threads: T2 open, T1 open. No push, so no new review.",
  );
});

await test("CLV-313 a denied or empty answer leaves the question thread without a reply", async () => {
  for (const decision of [
    { decision: "denied" as const, answer: null },
    { decision: "answered" as const, answer: " " },
    { decision: "approved" as const, answer: "Yes." },
  ]) {
    using bridge = fakeStepBridge({
      effects: effects({
        threads: [thread("PRRT_6")],
        summary: "Thread T1: question Remove the option?",
      }),
      decisions: [decision],
    });
    const outcome = await answerReview(input);
    assert.deepEqual(
      methods(bridge.requests),
      read.concat(["waitForDecision"]),
    );
    assert.equal(
      reportOf(outcome),
      "Threads: T1 unanswered. No push, so no new review.",
    );
  }
});

await test("CLV-313 a reply that the privacy check refuses blocks the run with the privacy reason", async () => {
  using bridge = fakeStepBridge({
    effects: Object.assign(
      effects({
        threads: [thread("PRRT_7")],
        summary: "Thread T1: no change See the notes.",
      }),
      { "github reply-thread": [failed("private-path-in-change")] },
    ),
  });
  assert.deepEqual(await answerReview(input), {
    kind: "blocked",
    cycleId: input.cycleId,
    reason: "private-path-in-change",
    evidenceId: "answer",
  });
  assert.deepEqual(methods(bridge.requests), read.concat(["reply-thread"]));
});

await test("CLV-313 a pull request with no open thread ends without a turn", async () => {
  using bridge = fakeStepBridge({
    effects: effects({ threads: [], summary: "" }),
  });
  assert.equal(reportOf(await answerReview(input)), "No open review threads.");
  assert.deepEqual(methods(bridge.requests), ["prepare", "review-threads"]);
});

await test("CLV-313 the turn gets the pull request, its diff and at most ten open threads", async () => {
  using bridge = fakeStepBridge({
    effects: Object.assign(
      effects({ threads: [], summary: "Thread T1: no change Fine." }),
      {
        "github review-threads": [
          threads(
            Array.from({ length: 11 }, (_, index) =>
              thread(`PRRT_${String(index)}`, {
                line: index === 1 ? null : 3,
                outdated: index === 1,
              }),
            ),
            [{ author: "alice", body: "Please rename the flag." }],
          ),
        ],
      },
    ),
  });
  await answerReview(input);
  const prompt = String(payloads(bridge.requests, "run-turn").at(0));
  assert.match(prompt, /pull request #641/);
  assert.match(prompt, /git diff origin\/main\.\.\.HEAD/);
  assert.match(prompt, /The main checkout at main-checkout is read-only\./);
  assert.match(
    prompt,
    /Thread T1 on src\/a\.ts line 3 \(bot\):\ngreptile-apps: Finding of PRRT_0\./,
  );
  assert.match(prompt, /Thread T2 on src\/a\.ts \(bot, outdated\):/);
  assert.match(prompt, /Thread T10 on/);
  assert.doesNotMatch(prompt, /Thread T11 on/);
  assert.match(
    prompt,
    /Comments of people since the last commit:\nalice: Please rename the flag\.$/,
  );
});

await test("CLV-313 an invalid turn report blocks before any push or reply", async () => {
  for (const [summary, commits] of [
    ["Done.", ["abc1234 Fix"]],
    ["Thread T1: fixed abc1234", []],
    ["Thread T1: fixed 1234567", ["abc1234 Fix"]],
    ["Thread T1: fixed abc", ["abc1234 Fix"]],
  ] as const) {
    using bridge = fakeStepBridge({
      effects: effects({ threads: [thread("PRRT_8")], summary, commits }),
    });
    assert.deepEqual(await answerReview(input), {
      kind: "blocked",
      cycleId: input.cycleId,
      reason: "invalid-answer-report",
      evidenceId: "answer",
    });
    assert.deepEqual(methods(bridge.requests), read);
  }
});

await test("CLV-313 a failed or invalid step blocks the run with its reason", async () => {
  for (const [override, reason] of stepFailures) {
    using bridge = fakeStepBridge({
      effects: Object.assign(
        effects({
          threads: [thread("PRRT_1")],
          summary: "Thread T1: fixed abc1234",
          commits: ["abc1234 Fix"],
        }),
        override,
      ),
    });
    const outcome = await answerReview(input);
    assert.equal(
      outcome.kind === "blocked" ? outcome.reason : "none",
      reason,
      JSON.stringify(methods(bridge.requests)),
    );
  }
  assert.equal(
    (
      await answerReview({
        cycleId: "answer-2",
        repository: "main-checkout",
        input: { pullRequest: 0 },
      })
    ).kind,
    "blocked",
  );
});

await test("CLV-313 a Greptile review that does not come leaves the replies and ends the run", async () => {
  using bridge = fakeStepBridge({
    effects: Object.assign(
      effects({
        threads: [thread("PRRT_1", { bot: false })],
        summary: "Thread T1: fixed abc1234",
        commits: ["abc1234 Fix"],
      }),
      { "github wait-review": [failed("review-not-received")] },
    ),
  });
  assert.equal(
    reportOf(await answerReview(input)),
    "Threads: T1 open. Greptile review: review-not-received.",
  );
  assert.equal(methods(bridge.requests).at(-1), "wait-review");
});

await test("CLV-313 Never resolve keeps a fixed bot thread open with no effect", async () => {
  const request = {
    state: {
      task: {
        cycleId: "answer-1",
        repository: "main-checkout",
        pullRequest: 641,
      },
      tree: { target: "task-000000000641", base: "main", head },
      report: { answers: [], commit: pushedCommit },
      pushed: {
        number: 641,
        commit: pushedCommit,
        target: "task-000000000641",
      },
    },
    answer: {
      thread: {
        label: "T1",
        id: "PRRT_1",
        path: "src/a.ts",
        line: 3,
        outdated: false,
        bot: true,
        comments: [],
      },
      kind: "fixed",
      text: "abc1234",
    },
    round: 1,
  };
  {
    using bridge = fakeStepBridge({ effects: {} });
    assert.equal(await neverResolve(request), "T1 open");
    assert.deepEqual(bridge.requests, []);
  }
  {
    using bridge = fakeStepBridge({
      effects: { "github resolve-thread": [completed({ resolved: true })] },
    });
    assert.equal(await resolveAfterFix(request), "T1 resolved");
    assert.deepEqual(methods(bridge.requests), ["resolve-thread"]);
  }
});
