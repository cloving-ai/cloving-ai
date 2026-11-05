import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { withFiles } from "./quality/files-fixture.ts";
import { directWatch } from "./watch-direct-fixture.ts";
import { laggingClock } from "./clock-lag-fixture.ts";
import { testMilliseconds } from "./test-timing.ts";

const replyMilliseconds = 200;
const settings = { replyMilliseconds };

async function silentService(runtime: string): Promise<() => Promise<void>> {
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
  });
  await new Promise<void>((settle) => {
    server.listen(join(runtime, "control.sock"), settle);
  });
  return async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((settle) => server.close(settle));
  };
}

await test("CLV-298 a watch reply that never settles gets 503 after the reply deadline, and the watch logs watch-reply-timeout with the route", () =>
  withFiles({}, async (root) => {
    const release = await silentService(join(root, "run"));
    const watch = await directWatch(join(root, "run"), settings);
    const restore = laggingClock(50);
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
      restore();
      await release();
      assert.equal(await watch.stop(), 0);
    }
  }));

await test("CLV-298 an API reply that never settles gets a 503 problem reply with the code timeout after the reply deadline", () =>
  withFiles({}, async (root) => {
    const release = await silentService(join(root, "run"));
    const watch = await directWatch(join(root, "run"), settings);
    try {
      const reply = await fetch(`${watch.address}api/v1/runs`, {
        signal: AbortSignal.timeout(testMilliseconds(5000)),
      });
      assert.equal(reply.status, 503);
      assert.equal(
        reply.headers.get("content-type"),
        "application/problem+json",
      );
      assert.deepEqual(await reply.json(), {
        type: "about:blank",
        title: "Service Unavailable",
        status: 503,
        detail:
          "The watch page did not complete the reply before the deadline.",
        code: "timeout",
      });
      assert.equal(watch.complaints.length, 1);
      assert.match(
        watch.complaints[0] ?? "",
        /^watch-reply-timeout path=\/api\/v1\/runs ms=\d+\n$/,
      );
    } finally {
      await release();
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
