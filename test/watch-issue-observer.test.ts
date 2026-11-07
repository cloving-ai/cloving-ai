import assert from "node:assert/strict";
import { test } from "node:test";
import { issueObserver } from "../src/cli/watch-issue-observer.ts";
import type {
  WatchCommandOutput,
  WatchCommandRequest,
} from "../src/cli/watch-pr-command.ts";

const issue = {
  host: "github.com",
  owner: "cloving-ai",
  repository: "cloving-ai",
  number: 586,
};

function issueOutput(fields: Readonly<Record<string, unknown>>) {
  return {
    stdout: JSON.stringify({
      number: 586,
      html_url: "https://github.com/Cloving-AI/cloving-ai/issues/586",
      ...fields,
    }),
    stderr: "",
    status: 0,
    errorCode: null,
  };
}

function settled(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

function observed(
  replies: (() => Promise<WatchCommandOutput>)[],
  clock: { at: number } = { at: 0 },
) {
  const requests: WatchCommandRequest[] = [];
  const observer = issueObserver({
    command: ["fake-gh"],
    directory: "service-repository",
    now: () => clock.at,
    execute: (request) => {
      requests.push(request);
      const reply = replies.shift();
      if (reply === undefined) throw new Error("no-reply");
      return reply();
    },
  });
  return { observer, requests, clock };
}

await test("CLV-321 the watch reads the state of a ticket issue once and then shows it", async () => {
  const { observer, requests } = observed([
    () => Promise.resolve(issueOutput({ state: "closed" })),
  ]);
  try {
    assert.equal(observer.state(issue), "unknown");
    assert.equal(observer.state(issue), "unknown");
    await settled();
    assert.equal(observer.state(issue), "closed");
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0]?.command, [
      "fake-gh",
      "api",
      "--method",
      "GET",
      "--hostname",
      "github.com",
      "repos/cloving-ai/cloving-ai/issues/586",
    ]);
    assert.equal(requests[0].directory, "service-repository");
  } finally {
    observer.close();
  }
});

await test("CLV-321 an open ticket is read again after one minute, and a closed ticket is not", async () => {
  const { observer, requests, clock } = observed([
    () => Promise.resolve(issueOutput({ state: "open" })),
    () => Promise.resolve(issueOutput({ state: "closed" })),
  ]);
  try {
    observer.state(issue);
    await settled();
    assert.equal(observer.state(issue), "open");
    clock.at = 59_999;
    assert.equal(observer.state(issue), "open");
    clock.at = 60_000;
    assert.equal(observer.state(issue), "open");
    await settled();
    assert.equal(observer.state(issue), "closed");
    clock.at = 600_000;
    assert.equal(observer.state(issue), "closed");
    assert.equal(requests.length, 2);
  } finally {
    observer.close();
  }
});

await test("CLV-321 a failed or foreign issue read keeps the last known state", async () => {
  const failures = [
    () =>
      Promise.resolve({
        stdout: "",
        stderr: "HTTP 404",
        status: 1,
        errorCode: null,
      }),
    () =>
      Promise.resolve({
        stdout: "",
        stderr: "",
        status: null,
        errorCode: "ENOENT",
      }),
    () => Promise.resolve(issueOutput({ state: "closed", number: 587 })),
    () =>
      Promise.resolve(
        issueOutput({
          state: "closed",
          html_url: "https://github.com/cloving-ai/cloving-ai/pull/586",
        }),
      ),
    () => Promise.resolve(issueOutput({ state: "merged" })),
    () => Promise.resolve({ ...issueOutput({}), stdout: "not json" }),
    () => Promise.reject(new Error("spawn-failed")),
  ];
  const { observer, clock } = observed([
    () => Promise.resolve(issueOutput({ state: "open" })),
    ...failures,
  ]);
  try {
    observer.state(issue);
    await settled();
    for (const index of failures.keys()) {
      clock.at = (index + 1) * 60_000;
      assert.equal(observer.state(issue), "open");
      await settled();
      assert.equal(observer.state(issue), "open");
    }
  } finally {
    observer.close();
  }
});

await test("CLV-321 the watch reads one ticket at a time and reads nothing with no command or after close", async () => {
  const held = Promise.withResolvers<WatchCommandOutput>();
  const { observer, requests } = observed([
    () => held.promise,
    () => Promise.resolve(issueOutput({ number: 587, state: "closed" })),
  ]);
  const other = { ...issue, number: 587 };
  observer.state(issue);
  observer.state(other);
  await settled();
  assert.equal(requests.length, 1);
  held.resolve(issueOutput({ state: "open" }));
  await settled();
  await settled();
  assert.equal(requests.length, 2);
  observer.close();
  assert.equal(requests[0]?.signal.aborted, true);
  assert.equal(observer.state({ ...issue, number: 588 }), "unknown");
  await settled();
  assert.equal(requests.length, 2);
  const silent = issueObserver({
    command: null,
    directory: "service-repository",
    execute: () => {
      throw new Error("no-read");
    },
  });
  assert.equal(silent.state(issue), "unknown");
  silent.close();
});
