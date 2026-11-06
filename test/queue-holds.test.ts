import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { holdRecord } from "../src/daemon/queue-holds.ts";
import type { QueueHold } from "../src/queue-room.ts";

const load: QueueHold = {
  reason: "load",
  loadPerCore: 0.9,
  limit: 0.7,
  text: "Held: load 0.90 for each core, limit 0.70",
};
const memory: QueueHold = {
  reason: "memory",
  pressure: "warn",
  limit: "normal",
  text: "Held: memory pressure warn, limit normal",
};
const day = 86_400_000;

async function withFolder(body: (folder: string) => Promise<void>) {
  const folder = await mkdtemp(join(tmpdir(), "queue-holds-"));
  try {
    await body(folder);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

await test("CLV-309 the hold record keeps load and memory hold periods across a restart", () =>
  withFolder(async (folder) => {
    const clock = { now: 40 * day };
    const now = () => clock.now;
    const first = await holdRecord(folder, now);
    await first.note(load);
    clock.now += 1000;
    await first.note(load);
    clock.now += 1000;
    await first.note(memory);
    assert.deepEqual(first.periods(), [
      { reason: "load", startedAt: 40 * day, endedAt: 40 * day + 2000 },
      { reason: "memory", startedAt: 40 * day + 2000, endedAt: null },
    ]);
    clock.now += 500;
    await first.close();
    const second = await holdRecord(folder, now);
    assert.deepEqual(second.periods(), [
      { reason: "load", startedAt: 40 * day, endedAt: 40 * day + 2000 },
      {
        reason: "memory",
        startedAt: 40 * day + 2000,
        endedAt: 40 * day + 2500,
      },
    ]);
    clock.now += 31 * day;
    await second.note(undefined);
    await second.note(load);
    await second.note(undefined);
    assert.deepEqual(second.periods(), [
      { reason: "load", startedAt: 71 * day + 2500, endedAt: 71 * day + 2500 },
    ]);
  }));

await test("CLV-309 the hold record refuses a hold file that is not valid", () =>
  withFolder(async (folder) => {
    for (const text of [
      "not JSON",
      '{"periods":[{"reason":"spend","startedAt":1,"endedAt":2}]}',
      '{"periods":[{"reason":"load","startedAt":2,"endedAt":1}]}',
      '{"periods":{}}',
    ]) {
      await writeFile(join(folder, "queue-holds.json"), text);
      await assert.rejects(holdRecord(folder), /invalid-queue-holds/);
    }
    await rm(join(folder, "queue-holds.json"));
    const empty = await holdRecord(folder);
    await empty.close();
    assert.deepEqual(empty.periods(), []);
    await assert.rejects(readFile(join(folder, "queue-holds.json"), "utf8"), {
      code: "ENOENT",
    });
  }));
