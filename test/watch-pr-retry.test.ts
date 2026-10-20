import assert from "node:assert/strict";
import { test } from "node:test";
import {
  observing,
  fakePrClock,
  prOutput,
  prRepositoryFixture,
  recordedPr,
  settleObservation,
} from "./watch-pr-fixture.ts";

await test("CLV-129 a host deadline pauses another queued PR and deduplicates waiting clients", async () => {
  const clock = fakePrClock();
  const { observer, attempts } = observing(clock);
  const second = { number: 8, url: recordedPr.url.replace(/7$/, "8") };
  try {
    observer.observe(recordedPr);
    observer.observe(second);
    await settleObservation();
    attempts[0]?.finish({
      ...prOutput(false),
      status: 1,
      stdout:
        "HTTP/2.0 429\r\nRetry-After: 120\r\nX-RateLimit-Remaining: 0\r\nX-RateLimit-Reset: 181\r\n\r\n{}",
    });
    await settleObservation();
    assert.equal(attempts.length, 1);
    for (const pull of [second, second, second])
      assert.deepEqual(observer.observe(pull), {
        status: "pending",
        retryAt: 181000,
      });
    clock.advance(179999);
    await settleObservation();
    assert.equal(attempts.length, 1);
    clock.advance(1);
    await settleObservation();
    assert.equal(attempts.length, 2);
    assert.equal(attempts[1]?.started, 181000);
    assert.deepEqual(observer.observe(recordedPr), {
      status: "unavailable",
      failure: "rate-limit",
      retryAt: 181000,
    });
    attempts[1].finish(prOutput(false, 8));
    await settleObservation();
    assert.equal(attempts.length, 3);
    assert.equal(attempts[2]?.started, 181000);
  } finally {
    observer.close();
  }
});

await test("CLV-129 a short host delay preserves per-PR attempt spacing", async () => {
  const clock = fakePrClock();
  const { observer, attempts } = observing(clock);
  const second = { number: 8, url: recordedPr.url.replace(/7$/, "8") };
  try {
    observer.observe(recordedPr);
    observer.observe(second);
    await settleObservation();
    attempts[0]?.finish({
      ...prOutput(false),
      status: 1,
      stdout: "HTTP/2.0 429\r\nRetry-After: 5\r\n\r\n{}",
    });
    await settleObservation();
    clock.advance(4999);
    await settleObservation();
    assert.equal(attempts.length, 1);
    clock.advance(1);
    await settleObservation();
    assert.equal(attempts.length, 2);
    attempts[1]?.finish(prOutput(false, 8));
    await settleObservation();
    clock.advance(54999);
    observer.observe(recordedPr);
    assert.equal(attempts.length, 2);
    clock.advance(1);
    observer.observe(recordedPr);
    await settleObservation();
    assert.equal(attempts.length, 3);
    assert.equal(attempts[2]?.started, 61000);
  } finally {
    observer.close();
  }
});

await test("CLV-129 missing retry headers pause a host for 60 seconds and retain the last success", async () => {
  const clock = fakePrClock();
  const { observer, attempts } = observing(clock);
  const second = { number: 8, url: recordedPr.url.replace(/7$/, "8") };
  try {
    observer.observe(recordedPr);
    await settleObservation();
    attempts[0]?.finish(prOutput(false));
    await settleObservation();
    clock.advance(60000);
    observer.observe(recordedPr);
    observer.observe(second);
    await settleObservation();
    attempts[1]?.finish({
      ...prOutput(false),
      status: 1,
      stderr: "rate limit",
    });
    await settleObservation();
    const failure = {
      status: "unavailable",
      failure: "rate-limit",
      retryAt: 121000,
      lastSuccess: { status: "unmerged", readAt: 1000 },
    };
    assert.deepEqual(observer.observe(recordedPr), failure);
    clock.advance(59999);
    assert.deepEqual(observer.observe(recordedPr), failure);
    await settleObservation();
    assert.equal(attempts.length, 2);
    clock.advance(1);
    assert.deepEqual(observer.observe(recordedPr), failure);
    await settleObservation();
    assert.equal(attempts.length, 3);
  } finally {
    observer.close();
  }
});

await test("CLV-129 a paused host permits other hosts and closing cancels its queued wake", async () => {
  const clock = fakePrClock();
  const repository = { ...prRepositoryFixture };
  const { observer, attempts } = observing(clock, repository);
  const second = { number: 8, url: recordedPr.url.replace(/7$/, "8") };
  observer.observe(recordedPr);
  observer.observe(second);
  await settleObservation();
  attempts[0]?.finish({ ...prOutput(false), status: 1, stderr: "rate limit" });
  await settleObservation();
  repository.host = "other.example";
  observer.observe({
    ...recordedPr,
    url: recordedPr.url.replace("github.example", "other.example"),
  });
  await settleObservation();
  assert.equal(attempts.length, 2);
  assert.ok(attempts[1]?.request.command.includes("other.example"));
  observer.close();
  attempts[1]?.finish(prOutput(true));
  await settleObservation();
  clock.advance(60000);
  await settleObservation();
  assert.equal(attempts.length, 2);
  repository.host = "github.example";
  assert.deepEqual(observer.observe(second), { status: "pending" });
});
