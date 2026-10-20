import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { githubTiming } from "../src/daemon/github-operation.ts";
import {
  reviewCommit,
  reviewSummary,
  withReview,
} from "./github-review-retry-fixture.ts";

await test("CLV-155 retries a failed review request on the next poll and returns a later review", () =>
  withReview({ requestFailures: 1, reviewAfterRequests: 1 }, async (scene) => {
    assert.deepEqual(await scene.wait(), {
      number: 1,
      commit: reviewCommit,
      score: 5,
      summary: reviewSummary,
      findings: [],
    });
    assert.deepEqual(scene.requests, [300_000, 330_000]);
  }));

await test("CLV-155 retries failed requests when the diagnostic log cannot be appended", () =>
  withReview({ requestFailures: 1, reviewAfterRequests: 1 }, async (scene) => {
    mkdirSync(join(scene.folder, "review-failures.jsonl"));
    assert.deepEqual(await scene.wait(), {
      number: 1,
      commit: reviewCommit,
      score: 5,
      summary: reviewSummary,
      findings: [],
    });
    assert.deepEqual(scene.requests, [300_000, 330_000]);
  }));

await test("CLV-155 preserves timeout diagnostics when failed reads and requests cannot be logged", () =>
  withReview(
    { requestFailures: Infinity, readFailure: "all" },
    async (scene) => {
      mkdirSync(join(scene.folder, "review-failures.jsonl"));
      await assert.rejects(scene.wait(), {
        message: "review-not-received",
        detail: JSON.stringify({
          failedReads: 121,
          requests: 110,
          acceptedRequests: 0,
          lastFailure: {
            call: "read-review",
            reason: "github-call-failed",
            status: 503,
          },
        }),
      });
      assert.equal(scene.now(), githubTiming.limitMilliseconds);
    },
  ));

await test("CLV-155 spaces further requests from the confirmed retry and retains its last failure", () =>
  withReview({ requestFailures: 1 }, async (scene) => {
    await assert.rejects(scene.wait(), {
      message: "review-not-received",
      detail: JSON.stringify({
        failedReads: 0,
        requests: 4,
        acceptedRequests: 3,
        lastFailure: {
          call: "request-review",
          reason: "github-call-failed",
          status: 403,
        },
      }),
    });
    assert.deepEqual(scene.requests, [300_000, 330_000, 630_000, 930_000]);
  }));

await test("CLV-155 records malformed reads without retaining their private response text", () =>
  withReview({ readFailure: "malformed" }, async (scene) => {
    await assert.rejects(scene.wait(), {
      message: "review-not-received",
      detail: JSON.stringify({
        failedReads: 121,
        requests: 3,
        acceptedRequests: 3,
        lastFailure: {
          call: "read-review",
          reason: "invalid-review-response",
        },
      }),
    });
    const log = readFileSync(
      join(scene.folder, "review-failures.jsonl"),
      "utf8",
    );
    assert.equal(log.trim().split("\n").length, scene.reads.length);
    assert.doesNotMatch(log, /private|token/);
  }));

await test("CLV-155 counts and logs failed finding reads after a score is present", () =>
  withReview(
    { readFailure: "findings", reviewAfterRequests: 0 },
    async (scene) => {
      await assert.rejects(scene.wait(), {
        message: "review-not-received",
        detail: JSON.stringify({
          failedReads: 121,
          requests: 3,
          acceptedRequests: 3,
          lastFailure: {
            call: "read-review",
            reason: "github-call-failed",
            status: 503,
          },
        }),
      });
      const log = readFileSync(
        join(scene.folder, "review-failures.jsonl"),
        "utf8",
      );
      assert.equal(scene.reads.length, 242);
      assert.equal(log.trim().split("\n").length, 121);
      assert.doesNotMatch(log, /private|token/);
    },
  ));

await test("CLV-155 sends at most three accepted requests spaced by the trigger time and waits until the limit", () =>
  withReview({}, async (scene) => {
    await assert.rejects(scene.wait(), {
      message: "review-not-received",
    });
    assert.deepEqual(scene.requests, [300_000, 600_000, 900_000]);
    assert.equal(scene.now(), githubTiming.limitMilliseconds);
  }));

await test("CLV-155 logs every failed read and request with safe reasons and retains timeout counts", () =>
  withReview(
    { requestFailures: Infinity, readFailure: "all" },
    async (scene) => {
      await assert.rejects(scene.wait(), {
        message: "review-not-received",
        detail: JSON.stringify({
          failedReads: 121,
          requests: 110,
          acceptedRequests: 0,
          lastFailure: {
            call: "read-review",
            reason: "github-call-failed",
            status: 503,
          },
        }),
      });
      assert.equal(scene.reads.length, 121);
      assert.equal(scene.requests.length, 110);
      const log = readFileSync(
        join(scene.folder, "review-failures.jsonl"),
        "utf8",
      );
      const lines = log.trim().split("\n");
      assert.equal(lines.length, scene.reads.length + scene.requests.length);
      assert.deepEqual(JSON.parse(lines[0] ?? ""), {
        call: "read-review",
        reason: "github-call-failed",
        status: 503,
      });
      assert.deepEqual(JSON.parse(lines[11] ?? ""), {
        call: "request-review",
        reason: "github-call-failed",
        status: 403,
      });
      assert.doesNotMatch(log, /private|token/);
    },
  ));
