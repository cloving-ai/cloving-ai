import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { throttled, watchStream } from "../src/cli/watch-stream.ts";
import { startedRun, withHarness, type Harness } from "./service-fixture.ts";

async function reached(condition: () => boolean): Promise<boolean> {
  for (let waited = 0; waited < 400 && !condition(); waited += 1)
    await delay(10);
  return condition();
}

interface Counter {
  count: number;
}

async function more(counter: Counter, action: () => unknown): Promise<boolean> {
  await delay(250);
  const before = counter.count;
  await action();
  return reached(() => counter.count > before);
}

await test("CLV-016 a burst of changes of the watch stream gives one notification at once and one more at the end of the interval", async () => {
  const calls: number[] = [];
  const notify = throttled(() => calls.push(calls.length), 60);
  notify();
  notify();
  notify();
  assert.equal(calls.length, 1);
  await delay(150);
  assert.equal(calls.length, 2);
  notify();
  assert.equal(calls.length, 3);
  await delay(150);
  assert.equal(calls.length, 3);
});

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
  assert.equal(
    await more(seen, () => {
      appendFileSync(unstartedLines, "{}\n");
    }),
    false,
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
  assert.equal(
    await more(seen, () => {
      appendFileSync(lines, "{}\n");
    }),
    false,
    "the stream file of a turn at its end",
  );
  assert.ok(await more(seen, () => service.close()), "the service stops");
}

await test("CLV-016 the watch stream is quiet with no service and no journal, and it gives a notification when the service answers, when the service commits a change, when a turn starts, at each line of the stream file of a turn in work, when a turn ends and when the service stops, and not for a folder with no start file", () =>
  withHarness(async (harness) => {
    const journal = join(dirname(harness.runtimeDirectory), "journal");
    const stream = watchStream({
      runtimeDirectory: harness.runtimeDirectory,
      journal,
      retryMilliseconds: 30,
    });
    const seen: Counter = { count: 0 };
    stream.subscribe(() => {
      seen.count += 1;
    });
    try {
      await delay(200);
      assert.equal(seen.count, 0);
      await followedTurn(harness, { seen, journal });
    } finally {
      stream.close();
    }
  }));

await test("CLV-016 the watch stream connects again to a service that starts again, and a closed stream and a removed listener give no notification", () =>
  withHarness(async (harness) => {
    const journal = join(dirname(harness.runtimeDirectory), "journal");
    mkdirSync(journal, { recursive: true });
    const first = await harness.start();
    const stream = watchStream({
      runtimeDirectory: harness.runtimeDirectory,
      journal,
      retryMilliseconds: 30,
    });
    const seen: Counter = { count: 0 };
    const removed: Counter = { count: 0 };
    stream.subscribe(() => {
      seen.count += 1;
    });
    const remove = stream.subscribe(() => {
      removed.count += 1;
    });
    assert.ok(await reached(() => removed.count > 0));
    remove();
    await first.close();
    const second = await harness.start();
    assert.ok(
      await more(seen, () =>
        startedRun(harness, { service: second, commandId: "c-2" }),
      ),
      "a change of the second service",
    );
    const kept = removed.count;
    stream.close();
    await delay(250);
    const end = seen.count;
    writeFileSync(join(journal, "late.txt"), "x");
    await startedRun(harness, { service: second, commandId: "c-3" });
    await delay(300);
    assert.deepEqual([seen.count, removed.count], [end, kept]);
    await second.close();
  }));
