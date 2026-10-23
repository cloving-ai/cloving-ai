import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mock, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { parseCheckTimeFactor } from "../quality/test-execution.ts";
import { throttled, watchStream } from "../src/cli/watch-stream.ts";
import { startedRun, withHarness, type Harness } from "./service-fixture.ts";

type Advance = (milliseconds: number) => void;

async function advancing(
  result: Promise<void>,
  advance: Advance,
): Promise<void> {
  const state = { finished: false };
  result.then(
    () => {
      state.finished = true;
    },
    () => {
      state.finished = true;
    },
  );
  const deadline = performance.now() + 60_000;
  while (!state.finished) {
    if (performance.now() >= deadline)
      throw new Error("watch-stream-io-timeout");
    await delay(10);
    advance(10);
  }
  await result;
}

async function withClock(
  body: (advance: Advance) => Promise<void> | void,
): Promise<void> {
  const timeout = globalThis.setTimeout;
  const clear = globalThis.clearTimeout;
  const scheduled = new Map<NodeJS.Timeout, { at: number; run: () => void }>();
  let now = 0;
  mock.method(globalThis, "setTimeout", (run: () => void, milliseconds = 1) => {
    const handle = timeout(() => undefined, 1);
    clear(handle);
    scheduled.set(handle, { at: now + milliseconds, run });
    return handle;
  });
  mock.method(
    globalThis,
    "clearTimeout",
    (handle: NodeJS.Timeout | undefined) => {
      if (handle) scheduled.delete(handle);
      clear(handle);
    },
  );
  const advance: Advance = (milliseconds) => {
    const end = now + milliseconds;
    for (;;) {
      const next = [...scheduled].sort(
        ([, first], [, second]) => first.at - second.at,
      )[0];
      if (!next || next[1].at > end) break;
      const [handle, timer] = next;
      now = timer.at;
      scheduled.delete(handle);
      timer.run();
    }
    now = end;
  };
  try {
    const result = body(advance);
    if (result) await advancing(result, advance);
  } finally {
    mock.restoreAll();
  }
}

const quietAttempts = 400;
const noticeAttempts =
  3_000 * parseCheckTimeFactor(process.env["CLOVING_CHECK_TIME_FACTOR"]);

interface Waiting {
  readonly advance: Advance;
  readonly attempts: number;
}

async function reached(
  condition: () => boolean,
  waiting: Waiting,
): Promise<boolean> {
  for (let waited = 0; waited < waiting.attempts && !condition(); waited += 1) {
    await delay(10);
    waiting.advance(10);
  }
  return condition();
}

interface Counter {
  count: number;
  readonly advance: Advance;
}

async function changed(
  counter: Counter,
  wait: { readonly action: () => unknown; readonly attempts: number },
): Promise<boolean> {
  counter.advance(250);
  const before = counter.count;
  await wait.action();
  return reached(() => counter.count > before, {
    advance: counter.advance,
    attempts: wait.attempts,
  });
}

function more(counter: Counter, action: () => unknown): Promise<boolean> {
  return changed(counter, { action, attempts: noticeAttempts });
}

async function quiet(
  counter: Counter,
  action: () => unknown,
): Promise<boolean> {
  return !(await changed(counter, { action, attempts: quietAttempts }));
}

await test("CLV-016 a burst of changes of the watch stream gives one notification at once and one more at the end of the interval", () =>
  withClock((advance) => {
    const calls: number[] = [];
    const notify = throttled(() => calls.push(calls.length), 60);
    notify();
    notify();
    notify();
    assert.equal(calls.length, 1);
    advance(59);
    assert.equal(calls.length, 1);
    advance(1);
    assert.equal(calls.length, 2);
    advance(60);
    assert.equal(calls.length, 2);
    notify();
    assert.equal(calls.length, 3);
    advance(120);
    assert.equal(calls.length, 3);
  }));

async function followedTurn(
  harness: Harness,
  watched: { readonly seen: Counter; readonly journal: string },
): Promise<void> {
  const { seen, journal } = watched;
  const started: { service?: Awaited<ReturnType<typeof harness.start>> } = {};
  assert.ok(
    await more(seen, async () => {
      started.service = await harness.start();
    }),
    "the service answers",
  );
  const { service } = started;
  assert.ok(service);
  assert.ok(
    await more(seen, () => startedRun(harness, { service, commandId: "c-1" })),
    "the service commits a change",
  );
  const unstartedLines = join(journal, "targets", "turn.jsonl");
  mkdirSync(dirname(unstartedLines), { recursive: true });
  writeFileSync(unstartedLines, "{}\n");
  assert.ok(
    await quiet(seen, () => {
      appendFileSync(unstartedLines, "{}\n");
    }),
    "the stream file of a folder with no start file gets a line",
  );
  const turn = join(journal, "a1");
  const lines = join(turn, "turn.jsonl");
  assert.ok(
    await more(seen, () => {
      mkdirSync(turn, { recursive: true });
      writeFileSync(join(turn, "started.json"), "{}");
      writeFileSync(lines, "{}\n");
    }),
    "a turn starts",
  );
  for (const line of ["{}\n", "{}\n"])
    assert.ok(
      await more(seen, () => {
        appendFileSync(lines, line);
      }),
      "the stream file of a turn in work gets a line",
    );
  assert.ok(
    await more(seen, () => {
      writeFileSync(join(turn, "result.json"), "{}");
    }),
    "a turn ends",
  );
  assert.ok(
    await quiet(seen, () => {
      appendFileSync(lines, "{}\n");
    }),
    "the stream file of a turn at its end",
  );
  assert.ok(await more(seen, () => service.close()), "the service stops");
}

await test("CLV-016 the watch stream is quiet with no service and no journal, and it gives a notification when the service answers, when the service commits a change, when a turn starts, at each line of the stream file of a turn in work, when a turn ends and when the service stops, and not for a folder with no start file", () =>
  withClock((advance) =>
    withHarness(async (harness) => {
      const journal = join(dirname(harness.runtimeDirectory), "journal");
      const stream = watchStream({
        runtimeDirectory: harness.runtimeDirectory,
        journal,
        retryMilliseconds: 30,
      });
      const seen: Counter = { count: 0, advance };
      stream.subscribe(() => {
        seen.count += 1;
      });
      try {
        await delay(200);
        advance(200);
        assert.equal(seen.count, 0);
        await followedTurn(harness, { seen, journal });
      } finally {
        stream.close();
      }
    }),
  ));

await test("CLV-016 the watch stream connects again to a service that starts again, and a closed stream and a removed listener give no notification", () =>
  withClock((advance) =>
    withHarness(async (harness) => {
      const journal = join(dirname(harness.runtimeDirectory), "journal");
      mkdirSync(journal, { recursive: true });
      const first = await harness.start();
      const stream = watchStream({
        runtimeDirectory: harness.runtimeDirectory,
        journal,
        retryMilliseconds: 30,
      });
      const seen: Counter = { count: 0, advance };
      const removed: Counter = { count: 0, advance };
      stream.subscribe(() => {
        seen.count += 1;
      });
      const remove = stream.subscribe(() => {
        removed.count += 1;
      });
      assert.ok(
        await reached(() => removed.count > 0, {
          advance,
          attempts: noticeAttempts,
        }),
      );
      remove();
      const kept = removed.count;
      await first.close();
      const second = await harness.start();
      assert.ok(
        await more(seen, () =>
          startedRun(harness, { service: second, commandId: "c-2" }),
        ),
        "a change of the second service",
      );
      const end = seen.count;
      stream.close();
      advance(250);
      writeFileSync(join(journal, "late.txt"), "x");
      await startedRun(harness, { service: second, commandId: "c-3" });
      await delay(300);
      advance(300);
      assert.deepEqual([seen.count, removed.count], [end, kept]);
      await second.close();
    }),
  ));
