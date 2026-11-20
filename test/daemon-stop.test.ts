import assert from "node:assert/strict";
import { test } from "node:test";
import { stopLatch, type StopOptions } from "../tools/daemon-stop.ts";

function fakeHost() {
  const listeners = new Map<NodeJS.Signals, (() => void)[]>();
  const events: string[] = [];
  return {
    events,
    host: {
      on: (signal: NodeJS.Signals, listener: () => void) => {
        listeners.set(signal, [...(listeners.get(signal) ?? []), listener]);
      },
      exit: (code: number) => {
        events.push(`exit ${String(code)}`);
      },
    },
    send: (signal: NodeJS.Signals) => {
      for (const listener of listeners.get(signal) ?? []) listener();
    },
  };
}

function recordingClose(events: string[]) {
  return async (options: StopOptions) => {
    events.push(`close ${JSON.stringify(options)}`);
    await Promise.resolve();
    events.push("closed");
  };
}

await test("#857 a stop signal before the daemon start closes the started daemon, then exits 0", async () => {
  const { events, host, send } = fakeHost();
  const latch = stopLatch("SIGUSR2", host);
  send("SIGTERM");
  send("SIGTERM");
  assert.deepEqual(events, []);
  await latch.closeWith(recordingClose(events));
  assert.deepEqual(events, ["close {}", "closed", "exit 0"]);
});

await test("#857 a stop signal after the daemon start closes the daemon, then exits 0", async () => {
  const { events, host, send } = fakeHost();
  const closing = stopLatch("SIGUSR2", host).closeWith(recordingClose(events));
  await Promise.resolve();
  assert.deepEqual(events, []);
  send("SIGINT");
  await closing;
  assert.deepEqual(events, ["close {}", "closed", "exit 0"]);
});

await test("#857 the first stop signal selects the close options", async () => {
  const { events, host, send } = fakeHost();
  const latch = stopLatch("SIGUSR2", host);
  send("SIGUSR2");
  send("SIGTERM");
  await latch.closeWith(recordingClose(events));
  assert.deepEqual(events, ['close {"turns":"keep"}', "closed", "exit 0"]);
});
