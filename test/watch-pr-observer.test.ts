import assert from "node:assert/strict";
import { test } from "node:test";
import { prObserver } from "../src/cli/watch-pr-observer.ts";
import {
  observing,
  fakePrClock,
  prOutput,
  recordedPr,
  settleObservation,
} from "./watch-pr-fixture.ts";

await test("CLV-093 reads return immediately, deduplicate clients and refresh after 60 seconds without events", async () => {
  const clock = fakePrClock();
  const { observer, attempts } = observing(clock);
  try {
    assert.deepEqual(observer.observe(recordedPr), { status: "pending" });
    observer.observe(recordedPr);
    await settleObservation();
    assert.equal(attempts.length, 1);
    assert.deepEqual(attempts[0]?.request.command, [
      "fake-gh",
      "fixed-prefix",
      "api",
      "--method",
      "GET",
      "--hostname",
      "github.example",
      "repos/fixture/demo/pulls/7",
      "--include",
    ]);
    assert.equal(attempts[0].request.directory, "fixture-repository");
    attempts[0].finish(prOutput(false));
    await settleObservation();
    assert.deepEqual(observer.observe(recordedPr), {
      status: "unmerged",
      lastSuccess: { status: "unmerged", readAt: 1000 },
    });
    clock.advance(59999);
    observer.observe(recordedPr);
    assert.equal(attempts.length, 1);
    clock.advance(1);
    observer.observe(recordedPr);
    await settleObservation();
    assert.equal(attempts.length, 2);
    assert.equal((attempts[1]?.started ?? 0) - attempts[0].started, 60000);
    attempts[1]?.finish(prOutput(true));
    await settleObservation();
    assert.deepEqual(observer.observe(recordedPr), {
      status: "merged",
      lastSuccess: { status: "merged", readAt: clock.now() },
    });
    clock.advance(600000);
    observer.observe(recordedPr);
    assert.equal(attempts.length, 2);
  } finally {
    observer.close();
  }
});

await test("CLV-093 one queue deduplicates queued keys, times out at five seconds and ignores late output", async () => {
  const clock = fakePrClock();
  const { observer, attempts } = observing(clock);
  const second = { number: 8, url: recordedPr.url.replace(/7$/, "8") };
  try {
    observer.observe(recordedPr);
    observer.observe(second);
    observer.observe(second);
    await settleObservation();
    assert.equal(attempts.length, 1);
    clock.advance(4999);
    await settleObservation();
    assert.equal(attempts.length, 1);
    clock.advance(1);
    await settleObservation();
    assert.equal(attempts[0]?.request.signal.aborted, true);
    assert.equal(attempts.length, 1);
    assert.deepEqual(observer.observe(recordedPr), {
      status: "unavailable",
      failure: "timeout",
    });
    attempts[0].finish(prOutput(true));
    await settleObservation();
    assert.equal(attempts.length, 2);
    attempts[1]?.finish(prOutput(false, 8));
    await settleObservation();
    assert.deepEqual(observer.observe(recordedPr), {
      status: "unavailable",
      failure: "timeout",
    });
    assert.deepEqual(observer.observe(second), {
      status: "unmerged",
      lastSuccess: { status: "unmerged", readAt: 6000 },
    });
    clock.advance(54999);
    observer.observe(recordedPr);
    assert.equal(attempts.length, 2);
    clock.advance(1);
    observer.observe(recordedPr);
    await settleObservation();
    assert.equal(attempts.length, 3);
  } finally {
    observer.close();
  }
});

await test("CLV-093 failed attempts retain a fixed category and the same 60-second spacing", async () => {
  const clock = fakePrClock();
  const { observer, attempts } = observing(clock);
  try {
    observer.observe(recordedPr);
    await settleObservation();
    attempts[0]?.reject(new Error("credential and raw upstream text"));
    await settleObservation();
    assert.deepEqual(observer.observe(recordedPr), {
      status: "unavailable",
      failure: "command",
    });
    clock.advance(59999);
    observer.observe(recordedPr);
    assert.equal(attempts.length, 1);
    clock.advance(1);
    observer.observe(recordedPr);
    await settleObservation();
    assert.equal(attempts.length, 2);
  } finally {
    observer.close();
  }
});

await test("CLV-093 one cache separates hosts and repositories and serializes successful reads", async () => {
  const repository = {
    host: "github.example",
    owner: "fixture",
    repository: "demo",
  };
  const attempts: {
    command: readonly string[];
    finish: (output: ReturnType<typeof prOutput>) => void;
  }[] = [];
  const clock = fakePrClock();
  const observer = prObserver({
    clock,
    repository,
    directory: "fixture",
    command: ["fake-gh"],
    execute: (request) =>
      new Promise((finish) => {
        attempts.push({ command: request.command, finish });
      }),
  });
  try {
    observer.observe(recordedPr);
    await settleObservation();
    attempts[0]?.finish(prOutput(true));
    await settleObservation();
    assert.deepEqual(observer.observe(recordedPr), {
      status: "merged",
      lastSuccess: { status: "merged", readAt: clock.now() },
    });
    repository.host = "other.example";
    const hostPr = {
      ...recordedPr,
      url: recordedPr.url.replace("github.example", "other.example"),
    };
    assert.deepEqual(observer.observe(hostPr), { status: "pending" });
    repository.repository = "other";
    const otherPr = { ...hostPr, url: hostPr.url.replace("/demo/", "/other/") };
    assert.deepEqual(observer.observe(otherPr), { status: "pending" });
    observer.observe(otherPr);
    await settleObservation();
    assert.equal(attempts.length, 2);
    attempts[1]?.finish(prOutput(false));
    await settleObservation();
    assert.equal(attempts.length, 3);
    assert.ok(attempts[1]?.command.includes("other.example"));
    assert.ok(attempts[2]?.command.includes("repos/fixture/other/pulls/7"));
    repository.host = "github.example";
    repository.repository = "demo";
    assert.deepEqual(observer.observe(recordedPr), {
      status: "merged",
      lastSuccess: { status: "merged", readAt: clock.now() },
    });
  } finally {
    observer.close();
  }
});

await test("CLV-129 queued and active first reads remain pending for repeated clients", async () => {
  const { observer, attempts } = observing();
  const second = { number: 8, url: recordedPr.url.replace(/7$/, "8") };
  try {
    for (const pull of [recordedPr, second, recordedPr, second])
      assert.deepEqual(observer.observe(pull), { status: "pending" });
    await settleObservation();
    assert.equal(attempts.length, 1);
    assert.deepEqual(observer.observe(recordedPr), { status: "pending" });
    attempts[0]?.finish(prOutput(false));
    await settleObservation();
    assert.equal(attempts.length, 2);
    assert.deepEqual(observer.observe(second), { status: "pending" });
  } finally {
    observer.close();
  }
});

await test("CLV-129 success time belongs to the reply and survives failed and pending refreshes", async () => {
  const clock = fakePrClock();
  const { observer, attempts } = observing(clock);
  try {
    observer.observe(recordedPr);
    await settleObservation();
    clock.advance(2000);
    attempts[0]?.finish(prOutput(false));
    await settleObservation();
    const lastSuccess = { status: "unmerged", readAt: 3000 };
    assert.deepEqual(observer.observe(recordedPr), {
      status: "unmerged",
      lastSuccess,
    });
    clock.advance(58000);
    assert.deepEqual(observer.observe(recordedPr), {
      status: "unmerged",
      lastSuccess,
    });
    await settleObservation();
    attempts[1]?.reject(new Error("private upstream detail"));
    await settleObservation();
    const failed = { status: "unavailable", failure: "command", lastSuccess };
    assert.deepEqual(observer.observe(recordedPr), failed);
    clock.advance(60000);
    assert.deepEqual(observer.observe(recordedPr), failed);
    await settleObservation();
    clock.advance(1000);
    attempts[2]?.finish(prOutput(false));
    await settleObservation();
    assert.deepEqual(observer.observe(recordedPr), {
      status: "unmerged",
      lastSuccess: { status: "unmerged", readAt: 122000 },
    });
  } finally {
    observer.close();
  }
});

await test("CLV-129 a timed out refresh retains the last success and discards a late merge", async () => {
  const clock = fakePrClock();
  const { observer, attempts } = observing(clock);
  try {
    observer.observe(recordedPr);
    await settleObservation();
    attempts[0]?.finish(prOutput(false));
    await settleObservation();
    clock.advance(60000);
    observer.observe(recordedPr);
    await settleObservation();
    clock.advance(5000);
    const expected = {
      status: "unavailable",
      failure: "timeout",
      lastSuccess: { status: "unmerged", readAt: 1000 },
    };
    assert.deepEqual(observer.observe(recordedPr), expected);
    attempts[1]?.finish(prOutput(true));
    await settleObservation();
    assert.deepEqual(observer.observe(recordedPr), expected);
  } finally {
    observer.close();
  }
});
