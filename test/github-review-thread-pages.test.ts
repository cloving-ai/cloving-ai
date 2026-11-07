import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { located } from "../src/daemon/operation-journal.ts";
import { withGithub } from "./github-worker-fixture.ts";
import {
  comment,
  graphqlCalls,
  greptile,
  listed,
  parsed,
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

function strangers(id: string, count: number) {
  return Array.from({ length: count }, (_, order) =>
    comment(`${id}_stranger_${String(order)}`, {
      login: "mallory",
      association: "NONE",
      minute: 3 + (order % 50),
    }),
  );
}

function flooded(id: string, reply: { readonly login: string }) {
  return [
    comment(`${id}_0`, { ...greptile, minute: 1 }),
    comment(`${id}_1`, { ...reply, minute: 2 }),
  ].concat(strangers(id, 60));
}

function openThread(id: string, minute: number) {
  return thread(`PRRT_${id}`, {
    comments: [comment(`PRRC_${id}`, { ...greptile, minute })],
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

await test("CLV-313 review-threads reads earlier comment pages when comments of unknown people fill the last ten, so a reply of the operator still drops its thread", () =>
  withGithub(async (scene) => {
    scene.plan({
      scores: [],
      reviewPull: reviewPull([
        thread("PRRT_done", {
          resolved: true,
          comments: flooded("PRRT_done", { login: "alice" }),
        }),
        thread("PRRT_replied", {
          comments: flooded("PRRT_replied", { login: "operator" }),
        }),
        thread("PRRT_waiting", {
          comments: flooded("PRRT_waiting", { login: "alice" }),
        }),
      ]),
    });
    const threads = listed((await read(scene, scene.worker()))["threads"]);
    assert.deepEqual(
      threads.map((item) => [
        item["id"],
        listed(item["comments"]).map((entry) => entry["id"]),
      ]),
      [["PRRT_waiting", ["PRRT_waiting_0", "PRRT_waiting_1"]]],
    );
    assert.deepEqual(
      graphqlCalls(scene, "before: $cursor").map((call) =>
        call.filter((part) => /^(?:thread|cursor)=/.test(part)),
      ),
      [
        ["thread=PRRT_replied", "cursor=52"],
        ["thread=PRRT_replied", "cursor=2"],
        ["thread=PRRT_waiting", "cursor=52"],
        ["thread=PRRT_waiting", "cursor=2"],
      ],
    );
  }));

await test("CLV-313 review-threads refuses a thread with more earlier comment pages than its limit", () =>
  withGithub(async (scene) => {
    scene.plan({
      scores: [],
      reviewPull: reviewPull([
        thread("PRRT_long", {
          comments: [comment("PRRT_long_0", { ...greptile, minute: 1 })].concat(
            strangers("PRRT_long", 520),
          ),
        }),
      ]),
    });
    const report = await scene.perform(scene.worker(), {
      method: "review-threads",
      payload: { number: 7 },
    });
    assert.deepEqual(
      [report.outcome, report.reason],
      ["failed", "review-threads-limit"],
    );
    assert.equal(graphqlCalls(scene, "before: $cursor").length, 10);
  }));

await test("CLV-313 record-answered keeps the comment of every open thread, also past 500 threads", () =>
  withGithub(async (scene) => {
    const ids = Array.from({ length: 501 }, (_, index) => String(index));
    scene.plan({
      scores: [],
      reviewPull: reviewPull(ids.map((id) => openThread(id, 1))),
    });
    const worker = scene.worker();
    for (let start = 0; start < ids.length; start += 100) {
      const report = await scene.perform(worker, {
        method: "record-answered",
        payload: {
          number: 7,
          comments: ids.slice(start, start + 100).map((id) => `PRRC_${id}`),
        },
      });
      assert.equal(report.outcome, "completed", JSON.stringify(report));
    }
    const threads = listed((await read(scene, worker))["threads"]);
    assert.ok(threads.length > 0);
    assert.deepEqual(
      threads
        .filter((item) => item["answered"] !== true)
        .map((item) => item["id"]),
      [],
    );
  }));

await test("CLV-313 record-answered drops the comments of threads that are resolved or have a newer comment", () =>
  withGithub(async (scene) => {
    scene.plan({
      scores: [],
      reviewPull: reviewPull([
        openThread("A", 1),
        openThread("B", 2),
        openThread("C", 3),
      ]),
    });
    const worker = scene.worker();
    const first = await scene.perform(worker, {
      method: "record-answered",
      payload: { number: 7, comments: ["PRRC_A", "PRRC_B"] },
    });
    assert.equal(first.outcome, "completed", JSON.stringify(first));
    scene.plan({
      scores: [],
      reviewPull: reviewPull([
        thread("PRRT_A", {
          resolved: true,
          comments: [comment("PRRC_A", { ...greptile, minute: 1 })],
        }),
        thread("PRRT_B", {
          comments: [
            comment("PRRC_B", { ...greptile, minute: 2 }),
            comment("PRRC_B2", { login: "alice", minute: 4 }),
          ],
        }),
        openThread("C", 3),
      ]),
    });
    const second = await scene.perform(worker, {
      method: "record-answered",
      payload: { number: 7, comments: ["PRRC_C"] },
    });
    assert.equal(second.outcome, "completed", JSON.stringify(second));
    const { folder } = located(scene.journal, second.operationId);
    const record = parsed(
      readFileSync(join(dirname(folder), "answered", "pull-7.json"), "utf8"),
    );
    assert.deepEqual(record["comments"], ["PRRC_C"]);
  }));

await test("CLV-313 review-threads skips a comment with no author login and fails closed on a comment with no time", () =>
  withGithub(async (scene) => {
    scene.plan({
      scores: [],
      reviewPull: reviewPull([
        thread("PRRT_ghost", {
          comments: [
            comment("PRRC_root", { ...greptile, minute: 1 }),
            comment("PRRC_alice", { login: "alice", minute: 2 }),
            {
              ...comment("PRRC_gone", { login: "gone", minute: 3 }),
              author: null,
            },
          ],
        }),
      ]),
    });
    const worker = scene.worker();
    const threads = listed((await read(scene, worker))["threads"]);
    assert.deepEqual(
      threads.map((item) => [
        item["id"],
        listed(item["comments"]).map((entry) => entry["id"]),
      ]),
      [["PRRT_ghost", ["PRRC_root", "PRRC_alice"]]],
    );
    const { createdAt, ...timeless } = comment("PRRC_timeless", {
      ...greptile,
      minute: 4,
    });
    assert.equal(typeof createdAt, "string");
    scene.plan({
      scores: [],
      reviewPull: reviewPull([
        thread("PRRT_timeless", { comments: [timeless] }),
      ]),
    });
    const report = await scene.perform(worker, {
      method: "review-threads",
      payload: { number: 7 },
    });
    assert.deepEqual(
      [report.outcome, report.reason],
      ["failed", "github-call-failed"],
    );
  }));
