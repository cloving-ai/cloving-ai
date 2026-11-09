import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { setImmediate as settled } from "node:timers/promises";
import type { ApiTranscriptPage } from "../src/cli/watch-api-transcript.ts";
import { transcriptStreamed } from "../src/cli/watch-transcript-stream.ts";
import { entry } from "./turn-transcript-fixture.ts";

function page(
  positions: readonly number[],
  state: { readonly open: boolean },
): ApiTranscriptPage {
  return {
    entries: positions.map((position) =>
      entry(position, { kind: "assistant", text: String(position) }),
    ),
    nextAfter: positions.at(-1) ?? 0,
    open: state.open,
  };
}

function exchange(writable: { full: boolean }) {
  const written: string[] = [];
  const listeners: (() => void)[] = [];
  const request = new EventEmitter();
  const response = Object.assign(new EventEmitter(), {
    writeHead: () => undefined,
    write: (chunk: string) => {
      written.push(chunk);
      return !writable.full;
    },
    end: () => {
      written.push("[end]");
    },
  });
  const stream = {
    subscribe: (listener: () => void) => {
      listeners.push(listener);
      return () => {
        listeners.splice(listeners.indexOf(listener), 1);
      };
    },
    close: () => undefined,
  };
  return { written, listeners, request, response, stream };
}

await test("CLV-329 a transcript stream waits for drain before it reads the next page when the reader is slow", async () => {
  const writable = { full: true };
  const shown = exchange(writable);
  const reads: number[] = [];
  transcriptStreamed(
    {
      kind: "transcript-stream",
      first: page([1, 2], { open: true }),
      read: (after) => {
        reads.push(after);
        return Promise.resolve(page([], { open: false }));
      },
    },
    shown,
  );
  await settled();
  await settled();
  assert.deepEqual(reads, []);
  writable.full = false;
  shown.response.emit("drain");
  await settled();
  await settled();
  assert.deepEqual(reads, [2]);
  assert.equal(shown.written.at(-1), "[end]");
  assert.equal(shown.response.listenerCount("drain"), 0);
});

await test("CLV-329 a transcript stream keeps one close listener while it waits and removes it at the end", async () => {
  const shown = exchange({ full: false });
  const pages = [
    page([], { open: true }),
    page([], { open: true }),
    page([], { open: false }),
  ];
  transcriptStreamed(
    {
      kind: "transcript-stream",
      first: page([], { open: true }),
      read: () => Promise.resolve(pages.shift() ?? page([], { open: false })),
    },
    shown,
  );
  for (let round = 0; round < 3; round += 1) {
    await settled();
    assert.equal(shown.request.listenerCount("close"), 1, String(round));
    shown.listeners[0]?.();
    await settled();
  }
  await settled();
  assert.equal(shown.written.at(-1), "[end]");
  assert.equal(shown.request.listenerCount("close"), 0);
});

await test("CLV-329 a transcript stream stops its wait for drain when the reader closes", async () => {
  const shown = exchange({ full: true });
  const reads: number[] = [];
  transcriptStreamed(
    {
      kind: "transcript-stream",
      first: page([1], { open: true }),
      read: (after) => {
        reads.push(after);
        return Promise.resolve(page([], { open: true }));
      },
    },
    shown,
  );
  await settled();
  shown.request.emit("close");
  await settled();
  await settled();
  assert.deepEqual(reads, []);
  assert.equal(shown.written.at(-1), "[end]");
  assert.equal(shown.response.listenerCount("drain"), 0);
  assert.equal(shown.request.listenerCount("close"), 0);
});
