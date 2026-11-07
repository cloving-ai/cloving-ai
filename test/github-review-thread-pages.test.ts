import assert from "node:assert/strict";
import { test } from "node:test";
import { withGithub } from "./github-worker-fixture.ts";
import {
  comment,
  graphqlCalls,
  greptile,
  listed,
  read,
  reviewPull,
  thread,
} from "./github-review-threads-fixture.ts";

function resolvedThreads(count: number) {
  return Array.from({ length: count }, (_, index) =>
    thread(`PRRT_done_${String(index)}`, {
      resolved: true,
      comments: [
        comment(`PRRC_done_${String(index)}`, { ...greptile, minute: 1 }),
      ],
    }),
  );
}

function author(order: number, last: { readonly login: string }) {
  if (order === 119) return last;
  return order % 2 === 0 ? greptile : { login: "alice" };
}

function longThread(id: string, last: { readonly login: string }) {
  return thread(id, {
    comments: Array.from({ length: 120 }, (_, order) =>
      comment(`${id}_${String(order)}`, {
        ...author(order, last),
        minute: order % 60,
      }),
    ),
  });
}

await test("CLV-313 review-threads reads every page of threads, so an open thread after many resolved threads is found", () =>
  withGithub(async (scene) => {
    scene.plan({
      scores: [],
      reviewPull: reviewPull(
        resolvedThreads(105).concat([
          thread("PRRT_late", {
            comments: [comment("PRRC_late", { ...greptile, minute: 40 })],
          }),
        ]),
      ),
    });
    const result = await read(scene, scene.worker());
    assert.deepEqual(
      listed(result["threads"]).map((item) => item["id"]),
      ["PRRT_late"],
    );
    const pages = graphqlCalls(scene, "reviewThreads(");
    assert.ok(pages.length > 1, String(pages.length));
    assert.ok(pages[0]?.every((part) => !part.startsWith("cursor=")));
    assert.ok(
      pages
        .slice(1)
        .every((call) => call.some((part) => part.startsWith("cursor="))),
    );
  }));

await test("CLV-313 review-threads reads the newest comment of a long thread and drops a thread that the operator answered last", () =>
  withGithub(async (scene) => {
    scene.plan({
      scores: [],
      reviewPull: reviewPull([
        longThread("PRRT_answered", { login: "operator" }),
        longThread("PRRT_open", greptile),
      ]),
    });
    const threads = listed((await read(scene, scene.worker()))["threads"]);
    assert.deepEqual(
      threads.map((item) => item["id"]),
      ["PRRT_open"],
    );
    assert.deepEqual(
      listed(threads[0]?.["comments"]).map((item) => item["id"]),
      [
        "PRRT_open_0",
        "PRRT_open_115",
        "PRRT_open_116",
        "PRRT_open_117",
        "PRRT_open_118",
        "PRRT_open_119",
      ],
    );
  }));

await test("CLV-313 the root comment owns a thread, so a bot reply on the thread of an unknown person keeps it a thread of a person", () =>
  withGithub(async (scene) => {
    scene.plan({
      scores: [],
      reviewPull: reviewPull([
        thread("PRRT_stranger", {
          comments: [
            comment("PRRC_1", {
              login: "mallory",
              minute: 20,
              association: "NONE",
            }),
            comment("PRRC_2", { ...greptile, minute: 21 }),
          ],
        }),
        thread("PRRT_bot", {
          comments: [
            comment("PRRC_3", { ...greptile, minute: 22 }),
            comment("PRRC_4", { login: "alice", minute: 23 }),
          ],
        }),
      ]),
    });
    const threads = listed((await read(scene, scene.worker()))["threads"]);
    assert.deepEqual(
      threads.map((item) => [
        item["id"],
        item["bot"],
        listed(item["comments"]).map((entry) => entry["id"]),
      ]),
      [
        ["PRRT_stranger", false, ["PRRC_2"]],
        ["PRRT_bot", true, ["PRRC_3", "PRRC_4"]],
      ],
    );
  }));

await test("CLV-313 review-threads refuses a pull request with more thread pages than its limit", () =>
  withGithub(async (scene) => {
    scene.plan({ scores: [], reviewPull: reviewPull(resolvedThreads(1_001)) });
    const report = await scene.perform(scene.worker(), {
      method: "review-threads",
      payload: { number: 7 },
    });
    assert.deepEqual(
      [report.outcome, report.reason],
      ["failed", "review-threads-limit"],
    );
    assert.equal(graphqlCalls(scene, "reviewThreads(").length, 20);
  }));
