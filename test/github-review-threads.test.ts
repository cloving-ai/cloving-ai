import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { located } from "../src/daemon/operation-journal.ts";
import { until } from "./claude-worker-fixture.ts";
import { githubIntent, withGithub } from "./github-worker-fixture.ts";
import {
  at,
  comment,
  graphqlCalls,
  greptile,
  head,
  listed,
  parsed,
  read,
  reviewPull,
  thread,
} from "./github-review-threads-fixture.ts";

const openReview = reviewPull(
  [
    thread("PRRT_bot", {
      comments: [comment("PRRC_1", { ...greptile, minute: 20 })],
    }),
    thread("PRRT_person", {
      outdated: true,
      line: null,
      comments: [comment("PRRC_2", { login: "alice", minute: 21 })],
    }),
    thread("PRRT_done", {
      resolved: true,
      comments: [comment("PRRC_3", { ...greptile, minute: 22 })],
    }),
    thread("PRRT_answered", {
      comments: [
        comment("PRRC_4", { ...greptile, minute: 23 }),
        comment("PRRC_5", { login: "operator", minute: 24 }),
      ],
    }),
    thread("PRRT_stranger", {
      comments: [
        comment("PRRC_6", {
          login: "mallory",
          minute: 25,
          association: "NONE",
        }),
      ],
    }),
  ],
  {
    comments: [
      comment("IC_1", { login: "alice", minute: 5 }),
      comment("IC_2", { login: "alice", minute: 30 }),
      comment("IC_3", { ...greptile, minute: 31 }),
      comment("IC_4", { login: "operator", minute: 32 }),
      comment("IC_5", {
        login: "mallory",
        minute: 33,
        association: "NONE",
      }),
    ],
  },
);

const openResult = {
  number: 7,
  head,
  threads: [
    {
      id: "PRRT_bot",
      path: "src/a.ts",
      line: 3,
      outdated: false,
      bot: true,
      answered: false,
      comments: [
        {
          id: "PRRC_1",
          author: "greptile-apps",
          bot: true,
          body: "Comment PRRC_1.",
          createdAt: at(20),
        },
      ],
    },
    {
      id: "PRRT_person",
      path: "src/a.ts",
      line: null,
      outdated: true,
      bot: false,
      answered: false,
      comments: [
        {
          id: "PRRC_2",
          author: "alice",
          bot: false,
          body: "Comment PRRC_2.",
          createdAt: at(21),
        },
      ],
    },
  ],
  comments: [
    {
      id: "IC_2",
      author: "alice",
      bot: false,
      body: "Comment IC_2.",
      createdAt: at(30),
    },
  ],
  latest: { id: "IC_2", at: at(30) },
};

await test("CLV-313 review-threads returns the open threads of a bot and a person and drops resolved and answered threads", () =>
  withGithub(async (scene) => {
    scene.plan({
      scores: [],
      reviewPull: openReview,
    });
    const result = await read(scene, scene.worker());
    const { quietSeconds, ...rest } = result;
    const since = Math.floor((Date.now() - Date.parse(at(30))) / 1000);
    assert.ok(
      typeof quietSeconds === "number" &&
        quietSeconds <= since &&
        quietSeconds >= since - 60,
      String(quietSeconds),
    );
    assert.deepEqual(rest, openResult);
    const [call] = graphqlCalls(scene, "reviewThreads(");
    assert.deepEqual(call?.slice(4), [
      "-F",
      "owner={owner}",
      "-F",
      "repo={repo}",
      "-F",
      "number=7",
    ]);
  }));

await test("CLV-313 record-answered marks each thread whose last comment a run took, and review-threads puts the other threads first", () =>
  withGithub(async (scene) => {
    scene.plan({
      scores: [],
      reviewPull: reviewPull(
        ["PRRT_1", "PRRT_2", "PRRT_3"].map((id, index) =>
          thread(id, {
            comments: [comment(`PRRC_${id}`, { ...greptile, minute: index })],
          }),
        ),
      ),
    });
    const worker = scene.worker();
    const recorded = [];
    for (const comments of [["PRRC_PRRT_1"], ["PRRC_PRRT_3", "PRRC_PRRT_1"]]) {
      const report = await scene.perform(worker, {
        method: "record-answered",
        payload: { number: 7, comments },
      });
      assert.equal(report.outcome, "completed", JSON.stringify(report));
      recorded.push(JSON.parse(String(report.result)));
    }
    assert.deepEqual(recorded, [
      { number: 7, comments: ["PRRC_PRRT_1"] },
      { number: 7, comments: ["PRRC_PRRT_3", "PRRC_PRRT_1"] },
    ]);
    const threads = listed((await read(scene, worker))["threads"]);
    assert.deepEqual(
      threads.map((item) => [item["id"], item["answered"]]),
      [
        ["PRRT_2", false],
        ["PRRT_1", true],
        ["PRRT_3", true],
      ],
    );
    const refused = [];
    for (const payload of [
      { number: 7, comment: "PRRC_PRRT_1" },
      { number: 7, comments: [] },
      { number: 7, comments: ["not a comment"] },
      { number: 7, comments: Array.from({ length: 101 }, () => "PRRC_1") },
    ]) {
      const report = await scene.perform(worker, {
        method: "record-answered",
        payload,
      });
      refused.push([report.outcome, report.reason]);
    }
    assert.deepEqual(
      refused,
      Array.from({ length: 4 }, () => ["failed", "invalid-payload"]),
    );
  }));

await test("CLV-313 review-threads cuts long comments, keeps the result in its byte limit and refuses a closed pull request", () =>
  withGithub(async (scene) => {
    const long = "y".repeat(9_000);
    scene.plan({
      scores: [],
      reviewPull: reviewPull(
        Array.from({ length: 60 }, (_, index) =>
          thread(`PRRT_${String(index)}`, {
            comments: Array.from({ length: 9 }, (_, order) =>
              comment(`PRRC_${String(index)}_${String(order)}`, {
                login: "alice",
                minute: 20 + order,
                body: long,
              }),
            ),
          }),
        ),
      ),
    });
    const worker = scene.worker();
    const result = await read(scene, worker);
    const threads = listed(result["threads"]);
    const comments = listed(threads[0]?.["comments"]);
    assert.deepEqual(
      comments.map((item) => item["id"]),
      ["PRRC_0_0", "PRRC_0_4", "PRRC_0_5", "PRRC_0_6", "PRRC_0_7", "PRRC_0_8"],
    );
    assert.equal(String(comments[0]?.["body"]).length, 3_000);
    assert.ok(threads.length > 0 && threads.length < 60);
    assert.ok(Buffer.byteLength(JSON.stringify(threads)) <= 120_000);
    assert.deepEqual(result["latest"], { id: "PRRC_0_8", at: at(28) });
    scene.plan({ scores: [], reviewPull: reviewPull([]) });
    const quiet = await read(scene, worker);
    assert.deepEqual([quiet["latest"], quiet["quietSeconds"]], [null, null]);
    scene.plan({ scores: [], reviewPull: reviewPull([], { state: "CLOSED" }) });
    const closed = await scene.perform(worker, {
      method: "review-threads",
      payload: { number: 7 },
    });
    assert.deepEqual(
      [closed.outcome, closed.reason],
      ["failed", "pull-request-not-open"],
    );
  }));

await test("CLV-313 reply-thread posts one reply through the privacy check, and resolve-thread resolves the thread", () =>
  withGithub(async (scene) => {
    const worker = scene.worker({ privateTexts: ["private organization"] });
    const reply = await scene.perform(worker, {
      method: "reply-thread",
      payload: { thread: "PRRT_bot", body: "Fixed in abc1234." },
    });
    assert.equal(reply.outcome, "completed", JSON.stringify(reply));
    const replied = parsed(String(reply.result));
    assert.equal(replied["thread"], "PRRT_bot");
    assert.match(String(replied["comment"]), /^PRRC_reply\d+$/);
    const refused = await scene.perform(worker, {
      method: "reply-thread",
      payload: {
        thread: "PRRT_bot",
        body: "See /Users/someone/project/a.ts for the fix.",
      },
    });
    const invalid = await scene.perform(worker, {
      method: "reply-thread",
      payload: { thread: "not a thread", body: "Fixed." },
    });
    assert.deepEqual(
      [refused, invalid].map((report) => [report.outcome, report.reason]),
      [
        ["failed", "private-path-in-change"],
        ["failed", "invalid-payload"],
      ],
    );
    const replies = graphqlCalls(scene, "addPullRequestReviewThreadReply(");
    assert.equal(replies.length, 1);
    const { key } = located(scene.journal, reply.operationId);
    assert.deepEqual(replies[0]?.slice(4), [
      "-f",
      "thread=PRRT_bot",
      "-f",
      `body=Fixed in abc1234.\n\n<!-- cloving-reply:${key} -->`,
    ]);
    const resolved = await scene.perform(worker, {
      method: "resolve-thread",
      payload: { thread: "PRRT_bot" },
    });
    assert.equal(resolved.outcome, "completed", JSON.stringify(resolved));
    assert.deepEqual(JSON.parse(String(resolved.result)), {
      thread: "PRRT_bot",
      resolved: true,
    });
    assert.deepEqual(graphqlCalls(scene, "resolveReviewThread(")[0]?.slice(4), [
      "-f",
      "thread=PRRT_bot",
    ]);
  }));

await test("CLV-313 a restarted reply-thread finds its posted reply by the marker and posts no second reply", () =>
  withGithub(async (scene) => {
    const { key, folder } = located(scene.journal, "operation-reply");
    const posted = (reply: {
      readonly thread: string;
      readonly id: string;
      readonly login: string;
    }) => ({
      thread: reply.thread,
      id: reply.id,
      body: `Fixed in abc1234.\n\n<!-- cloving-reply:${key} -->`,
      author: { login: reply.login },
    });
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      join(folder, "started.json"),
      JSON.stringify({
        ...githubIntent({
          operationId: "operation-reply",
          method: "reply-thread",
        }),
        payloadText: JSON.stringify({
          thread: "PRRT_bot",
          body: "Fixed in abc1234.",
        }),
      }),
    );
    scene.plan({
      scores: [],
      threadReplies: [
        posted({ thread: "PRRT_other", id: "PRRC_other", login: "operator" }),
        posted({ thread: "PRRT_bot", id: "PRRC_copy", login: "mallory" }),
        posted({ thread: "PRRT_bot", id: "PRRC_posted", login: "operator" }),
      ],
    });
    scene.worker({ privateTexts: ["private organization"] });
    await until(() =>
      scene.reports.some((report) => report.operationId === "operation-reply"),
    );
    const report = scene.reports.find(
      (item) => item.operationId === "operation-reply",
    );
    assert.equal(report?.outcome, "completed", JSON.stringify(report));
    assert.deepEqual(JSON.parse(String(report.result)), {
      thread: "PRRT_bot",
      comment: "PRRC_posted",
    });
    assert.deepEqual(
      graphqlCalls(scene, "addPullRequestReviewThreadReply("),
      [],
    );
    assert.deepEqual(
      graphqlCalls(scene, "on PullRequestReviewThread")[0]?.slice(4),
      ["-f", "thread=PRRT_bot"],
    );
  }));
