import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { closeSync, constants, openSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { withFiles } from "./quality/files-fixture.ts";
import { directWatch } from "./watch-direct-fixture.ts";
import { testMilliseconds } from "./test-timing.ts";

const replyMilliseconds = 200;
const settings = { replyMilliseconds };

async function stalledJournal(root: string): Promise<string> {
  const pipe = join(root, "journal/stalled/started.json");
  await mkdir(dirname(pipe), { recursive: true });
  execFileSync("mkfifo", [pipe]);
  return pipe;
}

function released(pipe: string): void {
  try {
    closeSync(openSync(pipe, constants.O_WRONLY | constants.O_NONBLOCK));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENXIO"))
      throw error;
  }
}

await test("CLV-298 a watch reply that never settles gets 503 after the reply deadline, and the watch logs watch-reply-timeout with the route", () =>
  withFiles({}, async (root) => {
    const pipe = await stalledJournal(root);
    const watch = await directWatch(join(root, "run"), settings);
    try {
      const reply = await fetch(`${watch.address}data.json?view=private`, {
        signal: AbortSignal.timeout(testMilliseconds(5000)),
      });
      assert.equal(reply.status, 503);
      assert.equal(await reply.text(), "timeout");
      assert.equal(watch.complaints.length, 1);
      const [line = ""] = watch.complaints;
      assert.match(line, /^watch-reply-timeout path=\/data\.json ms=\d+\n$/);
      const elapsed = Number(/ms=(\d+)/.exec(line)?.[1]);
      assert.ok(elapsed >= replyMilliseconds, line);
    } finally {
      released(pipe);
      assert.equal(await watch.stop(), 0);
    }
  }));

for (const path of ["events", "api/v1/stream"])
  await test(`CLV-298 the event stream ${path} stays open past the reply deadline`, () =>
    withFiles({}, async (root) => {
      const watch = await directWatch(join(root, "run"), settings);
      const stopping = new AbortController();
      try {
        const reply = await fetch(`${watch.address}${path}`, {
          signal: stopping.signal,
        });
        assert.equal(reply.status, 200);
        assert.match(
          reply.headers.get("content-type") ?? "",
          /^text\/event-stream/,
        );
        const body = reply.body;
        assert.ok(body !== null);
        const reader = body.getReader();
        assert.equal((await reader.read()).done, false);
        const next = reader
          .read()
          .then((chunk) => (chunk.done ? "ended" : "open"));
        const state = await Promise.race([
          next,
          delay(replyMilliseconds * 3).then(() => "open"),
        ]);
        assert.equal(state, "open");
        assert.deepEqual(watch.complaints, []);
        stopping.abort();
        await next.catch(() => "aborted");
      } finally {
        assert.equal(await watch.stop(), 0);
      }
    }));
