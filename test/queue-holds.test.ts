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
    assert.equal(second.cutAt(), 40 * day);
    clock.now += 31 * day;
    await second.note(undefined);
    await second.note(load);
    await second.note(undefined);
    assert.deepEqual(second.periods(), [
      { reason: "load", startedAt: 71 * day + 2500, endedAt: 71 * day + 2500 },
    ]);
    assert.equal(second.cutAt(), 40 * day + 2500);
    const third = await holdRecord(folder, now);
    assert.equal(third.cutAt(), 40 * day + 2500);
  }));

await test("CLV-309 an open hold survives a crash up to its last check of each minute", () =>
  withFolder(async (folder) => {
    const clock = { now: 40 * day };
    const now = () => clock.now;
    const first = await holdRecord(folder, now);
    await first.note(load);
    const started = await holdRecord(folder, now);
    assert.deepEqual(started.periods(), [
      { reason: "load", startedAt: 40 * day, endedAt: 40 * day },
    ]);
    for (const step of [30_000, 31_000, 29_000]) {
      clock.now += step;
      await first.note(load);
    }
    const crashed = await holdRecord(folder, now);
    assert.deepEqual(crashed.periods(), [
      { reason: "load", startedAt: 40 * day, endedAt: 40 * day + 61_000 },
    ]);
    await crashed.note(memory);
    await crashed.close();
    const restarted = await holdRecord(folder, now);
    assert.deepEqual(restarted.periods(), [
      { reason: "load", startedAt: 40 * day, endedAt: 40 * day + 61_000 },
      {
        reason: "memory",
        startedAt: 40 * day + 90_000,
        endedAt: 40 * day + 90_000,
      },
    ]);
  }));

await test("CLV-309 the hold record marks the end of the periods that its limit dropped", () =>
  withFolder(async (folder) => {
    const periods = Array.from({ length: 1000 }, (_, index) => ({
      reason: "load",
      startedAt: 40 * day + index * 10,
      endedAt: 40 * day + index * 10 + 5,
    }));
    await writeFile(
      join(folder, "queue-holds.json"),
      JSON.stringify({ periods, open: null, cutAt: null }),
    );
    const clock = { now: 41 * day };
    const record = await holdRecord(folder, () => clock.now);
    await record.note(memory);
    clock.now += 1000;
    await record.note(undefined);
    assert.equal(record.periods().length, 1000);
    assert.equal(record.cutAt(), 40 * day + 5);
    await record.note(load);
    await record.close();
    assert.equal(record.periods()[0]?.startedAt, 40 * day + 20);
    assert.equal(record.cutAt(), 40 * day + 15);
  }));

await test("CLV-309 the hold record refuses a hold file that is not valid", () =>
  withFolder(async (folder) => {
    for (const text of [
      "not JSON",
      '{"periods":[{"reason":"spend","startedAt":1,"endedAt":2}]}',
      '{"periods":[{"reason":"load","startedAt":2,"endedAt":1}]}',
      '{"periods":{}}',
      '{"periods":[],"open":{"reason":"load","startedAt":5,"seenAt":1}}',
      '{"periods":[],"open":{"reason":"spend","startedAt":1,"seenAt":5}}',
      '{"periods":[],"cutAt":-1}',
    ]) {
      await writeFile(join(folder, "queue-holds.json"), text);
      await assert.rejects(holdRecord(folder), /invalid-queue-holds/);
    }
    await rm(join(folder, "queue-holds.json"));
    const empty = await holdRecord(folder);
    await empty.close();
    assert.deepEqual(empty.periods(), []);
  }));

await test("CLV-309 a new hold record saves its start, so no hold history comes before it", () =>
  withFolder(async (folder) => {
    const first = await holdRecord(folder, () => 40 * day);
    assert.equal(first.cutAt(), 40 * day);
    const saved: unknown = JSON.parse(
      await readFile(join(folder, "queue-holds.json"), "utf8"),
    );
    assert.deepEqual(saved, { periods: [], open: null, cutAt: 40 * day });
    const restarted = await holdRecord(folder, () => 41 * day);
    assert.equal(restarted.cutAt(), 40 * day);
    assert.deepEqual(restarted.periods(), []);
  }));
