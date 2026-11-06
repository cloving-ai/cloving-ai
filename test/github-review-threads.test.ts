import assert from "node:assert/strict";
import { test } from "node:test";
import { withGithub, type GithubScene } from "./github-worker-fixture.ts";

const head = "c".repeat(40);

function at(minute: number): string {
  return `2026-11-06T10:${String(minute).padStart(2, "0")}:00Z`;
}

function comment(
  id: string,
  fields: {
    readonly login: string;
    readonly minute: number;
    readonly bot?: boolean;
    readonly association?: string;
    readonly body?: string;
  },
) {
  return {
    id,
    body: fields.body ?? `Comment ${id}.`,
    createdAt: at(fields.minute),
    authorAssociation: fields.association ?? "COLLABORATOR",
    author: { login: fields.login, __typename: fields.bot ? "Bot" : "User" },
  };
}

function thread(
  id: string,
  fields: {
    readonly comments: readonly unknown[];
    readonly resolved?: boolean;
    readonly outdated?: boolean;
    readonly line?: number | null;
  },
) {
  return {
    id,
    isResolved: fields.resolved ?? false,
    isOutdated: fields.outdated ?? false,
    path: "src/a.ts",
    line: fields.line === undefined ? 3 : fields.line,
    comments: { nodes: fields.comments },
  };
}

function reviewPull(
  threads: readonly unknown[],
  options: {
    readonly comments?: readonly unknown[];
    readonly state?: string;
  } = {},
) {
  return {
    state: options.state ?? "OPEN",
    commits: { nodes: [{ commit: { oid: head, committedDate: at(10) } }] },
    reviewThreads: { nodes: threads },
    comments: { nodes: options.comments ?? [] },
  };
}

function parsed(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  assert.ok(typeof value === "object" && value !== null);
  return Object.fromEntries(Object.entries(value));
}

function fieldOf(value: unknown, name: string): unknown {
  const result: unknown = Reflect.get(Object(value), name);
  return result;
}

const greptile = { login: "greptile-apps", bot: true, association: "NONE" };

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
  answered: null,
};

async function read(
  scene: GithubScene,
  worker: ReturnType<GithubScene["worker"]>,
) {
  const report = await scene.perform(worker, {
    method: "review-threads",
    payload: { number: 7 },
  });
  assert.equal(report.outcome, "completed", JSON.stringify(report));
  return parsed(String(report.result));
}

function graphqlCalls(scene: GithubScene, word: string) {
  return scene
    .state()
    .calls.filter(
      (call) =>
        call[1] === "graphql" && call.some((part) => part.includes(word)),
    );
}

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

await test("CLV-313 record-answered keeps the last answered comment that review-threads returns", () =>
  withGithub(async (scene) => {
    scene.plan({
      scores: [],
      reviewPull: reviewPull([
        thread("PRRT_bot", {
          comments: [comment("PRRC_1", { ...greptile, minute: 20 })],
        }),
      ]),
    });
    const worker = scene.worker();
    const recorded = await scene.perform(worker, {
      method: "record-answered",
      payload: { number: 7, comment: "PRRC_1" },
    });
    assert.equal(recorded.outcome, "completed", JSON.stringify(recorded));
    assert.deepEqual(JSON.parse(String(recorded.result)), {
      number: 7,
      comment: "PRRC_1",
    });
    const result = await read(scene, worker);
    assert.equal(result["answered"], "PRRC_1");
    assert.deepEqual(result["latest"], { id: "PRRC_1", at: at(20) });
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
    const threads = result["threads"];
    assert.ok(Array.isArray(threads));
    const first: unknown = threads[0];
    const comments = fieldOf(first, "comments");
    assert.ok(Array.isArray(comments));
    assert.deepEqual(
      comments.map((item: unknown) => fieldOf(item, "id")),
      ["PRRC_0_0", "PRRC_0_4", "PRRC_0_5", "PRRC_0_6", "PRRC_0_7", "PRRC_0_8"],
    );
    assert.equal(String(fieldOf(comments[0], "body")).length, 3_000);
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
    assert.deepEqual(replies[0]?.slice(4), [
      "-f",
      "thread=PRRT_bot",
      "-f",
      "body=Fixed in abc1234.",
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
