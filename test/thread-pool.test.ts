import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { stalledExit, threadPoolWatch } from "../src/cli/thread-pool.ts";
import {
  stalledLine,
  threadPoolStallExitCode,
  type ThreadPoolCheck,
} from "../src/thread-pool-check.ts";
import { laggingClock } from "./clock-lag-fixture.ts";
import { testMilliseconds } from "./test-timing.ts";

const timing = { intervalMilliseconds: 20, deadlineMilliseconds: 60 };

async function reached<Value>(read: () => Value | undefined): Promise<Value> {
  const deadline = performance.now() + testMilliseconds(5000);
  while (performance.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await delay(10);
  }
  throw new Error("thread-pool-condition-not-reached");
}

await test("CLV-298 a stall reports at least the deadline when the timer fires before the clock reaches it", async () => {
  const restore = laggingClock(5);
  const stalls: ThreadPoolCheck[] = [];
  const watch = threadPoolWatch({
    ...timing,
    check: () => new Promise(() => undefined),
    stalled: (check) => {
      stalls.push(check);
    },
  });
  try {
    const stall = await reached(() => stalls[0]);
    assert.ok(
      stall.milliseconds >= timing.deadlineMilliseconds,
      String(stall.milliseconds),
    );
  } finally {
    watch.stop();
    restore();
  }
});

await test("CLV-298 a pool check that never settles reports one stall with the counts of the active resources", async () => {
  const stalls: ThreadPoolCheck[] = [];
  let checks = 0;
  const held = setTimeout(() => undefined, testMilliseconds(60_000));
  const watch = threadPoolWatch({
    ...timing,
    check: () => {
      checks += 1;
      return new Promise(() => undefined);
    },
    stalled: (check) => {
      stalls.push(check);
    },
  });
  try {
    const stall = await reached(() => stalls[0]);
    assert.equal(stall.result, "stalled");
    assert.ok(stall.milliseconds >= timing.deadlineMilliseconds);
    assert.ok(Number.isFinite(Date.parse(stall.checkedAt)));
    assert.ok((stall.resources?.["Timeout"] ?? 0) >= 1);
    assert.deepEqual(watch.latest(), stall);
    await delay(timing.deadlineMilliseconds * 3);
    assert.equal(stalls.length, 1);
    assert.equal(checks, 1);
  } finally {
    clearTimeout(held);
    watch.stop();
  }
});

await test("CLV-298 the stall line names the elapsed time and the resource counts in name order", () => {
  assert.equal(
    stalledLine({
      result: "stalled",
      checkedAt: "2026-11-05T10:00:00.000Z",
      milliseconds: 5003,
      resources: { Timeout: 2, FSReqPromise: 3, TCPServerWrap: 1 },
    }),
    "threadpool-stalled ms=5003 resources=FSReqPromise:3,TCPServerWrap:1,Timeout:2\n",
  );
  assert.equal(threadPoolStallExitCode, 70);
});

await test("CLV-298 a pool check that settles in time records an ok result and no stall", async () => {
  const stalls: ThreadPoolCheck[] = [];
  const watch = threadPoolWatch({
    ...timing,
    check: () => Promise.reject(new Error("missing file")),
    stalled: (check) => {
      stalls.push(check);
    },
  });
  try {
    const latest = await reached(() => watch.latest());
    assert.equal(latest.result, "ok");
    assert.equal(latest.resources, undefined);
    await delay(timing.deadlineMilliseconds * 2);
    assert.deepEqual(stalls, []);
  } finally {
    watch.stop();
  }
});

await test("CLV-298 a stalled pool check that settles late makes the latest result ok again", async () => {
  const late = Promise.withResolvers<undefined>();
  const watch = threadPoolWatch({
    ...timing,
    intervalMilliseconds: 60_000,
    check: () => late.promise,
    stalled: () => undefined,
  });
  try {
    await reached(() =>
      watch.latest()?.result === "stalled" ? true : undefined,
    );
    late.resolve(undefined);
    const recovered = await reached(() =>
      watch.latest()?.result === "ok" ? watch.latest() : undefined,
    );
    assert.ok(recovered.milliseconds >= timing.deadlineMilliseconds);
  } finally {
    watch.stop();
  }
});

await test("CLV-298 the default pool check reads the status of a file of the install", async () => {
  const watch = threadPoolWatch({ ...timing, stalled: () => undefined });
  try {
    assert.equal((await reached(() => watch.latest())).result, "ok");
  } finally {
    watch.stop();
  }
});

await test("CLV-298 a stopped pool watch runs no more checks", async () => {
  let checks = 0;
  const watch = threadPoolWatch({
    ...timing,
    check: () => {
      checks += 1;
      return Promise.resolve();
    },
    stalled: () => undefined,
  });
  await reached(() => (checks > 0 ? true : undefined));
  watch.stop();
  const stoppedAt = checks;
  await delay(timing.intervalMilliseconds * 5);
  assert.equal(checks, stoppedAt);
});

await test("CLV-298 a stopped pool watch reports no stall of the check in progress", async () => {
  const stalls: ThreadPoolCheck[] = [];
  let checks = 0;
  const watch = threadPoolWatch({
    ...timing,
    check: () => {
      checks += 1;
      return new Promise(() => undefined);
    },
    stalled: (check) => {
      stalls.push(check);
    },
  });
  await reached(() => (checks > 0 ? true : undefined));
  watch.stop();
  await delay(timing.deadlineMilliseconds * 3);
  assert.deepEqual(stalls, []);
  assert.equal(watch.latest(), undefined);
});

await test("CLV-298 the pool watch runs its first check at its start", () => {
  let checks = 0;
  const watch = threadPoolWatch({
    intervalMilliseconds: 60_000,
    check: () => {
      checks += 1;
      return Promise.resolve();
    },
    stalled: () => undefined,
  });
  watch.stop();
  assert.equal(checks, 1);
});

function exitHost(options: { readonly execve: "works" | "fails" | "absent" }) {
  const calls: string[] = [];
  const flushed = { done: false };
  const ended = (text: string): never => {
    calls.push(text);
    throw new Error(text);
  };
  return {
    calls,
    host: {
      execPath: "/node",
      stderr: {
        write: (text: string, done: () => void) => {
          calls.push(`write ${JSON.stringify(text)}`);
          setTimeout(() => {
            flushed.done = true;
            done();
          }, 10);
          return false;
        },
      },
      exit: (code: number) => ended(`exit ${String(code)}`),
      ...(options.execve === "absent"
        ? {}
        : {
            execve: (file: string, args?: readonly string[]) =>
              ended(
                `execve ${String(flushed.done)} ${file} ${JSON.stringify(args)} ${options.execve}`,
              ),
          }),
    },
  };
}

await test("CLV-298 the stall exit flushes stderr, then replaces the process with a Node that exits with the stall exit code", async () => {
  const { calls, host } = exitHost({ execve: "works" });
  await assert.rejects(stalledExit(host), /exit 70/);
  assert.deepEqual(calls, [
    'write ""',
    'execve true /node ["/node","--eval","process.exitCode = 70"] works',
    "exit 70",
  ]);
});

await test("CLV-298 the stall exit calls exit with the stall exit code when the process has no execve", async () => {
  const { calls, host } = exitHost({ execve: "absent" });
  await assert.rejects(stalledExit(host), /exit 70/);
  assert.deepEqual(calls, ['write ""', "exit 70"]);
});
