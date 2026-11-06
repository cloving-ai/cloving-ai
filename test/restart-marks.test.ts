import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { restartMarks, startedQueue } from "../src/daemon/restart-marks.ts";
import type { QueueDrain } from "../src/queue-state.ts";

async function withDirectory(
  body: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "cloving-restart-"));
  try {
    await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

await test("CLV-306 the daemon keeps a pending restart in a private mark file that a cancel removes", () =>
  withDirectory(async (directory) => {
    const marks = restartMarks(directory);
    assert.equal(await marks.pending(), undefined);
    const mark = {
      at: "gap",
      requestedAt: 1_793_000_000_000,
      commandId: "one",
      resumeQueue: true,
    } as const;
    await marks.request(mark);
    assert.deepEqual(await marks.pending(), mark);
    assert.deepEqual(
      JSON.parse(await readFile(join(directory, "pending-restart"), "utf8")),
      mark,
    );
    assert.equal(await marks.cancel(), "cancelled");
    assert.equal(await marks.pending(), undefined);
    assert.equal(await marks.cancel(), "none");
  }));

await test("CLV-306 a restart that the host claimed stays pending and a cancel cannot remove it", () =>
  withDirectory(async (directory) => {
    const marks = restartMarks(directory);
    const mark = {
      at: "gap",
      requestedAt: 1_793_000_000_000,
      commandId: "one",
      resumeQueue: false,
    } as const;
    await marks.request(mark);
    await rename(
      join(directory, "pending-restart"),
      join(directory, "claimed-restart"),
    );
    assert.deepEqual(await marks.pending(), mark);
    assert.equal(await marks.cancel(), "started");
    assert.deepEqual(await marks.pending(), mark);
    const newer = {
      ...mark,
      commandId: "two",
      requestedAt: mark.requestedAt + 1,
    };
    await marks.request(newer);
    assert.deepEqual(await marks.pending(), newer);
    assert.equal(await marks.cancel(), "cancelled");
    await rm(join(directory, "claimed-restart"));
    await writeFile(join(directory, "pending-restart"), "{");
    assert.equal(await marks.cancel(), "none");
    assert.equal(await marks.pending(), undefined);
  }));

await test("CLV-306 a mark file that the daemon cannot read is no pending restart", () =>
  withDirectory(async (directory) => {
    const marks = restartMarks(directory);
    for (const text of [
      "",
      "{",
      '{"at":"later","requestedAt":1,"commandId":"one"}',
      '{"at":"now","requestedAt":1.5,"commandId":"one"}',
      '{"at":"now","requestedAt":1}',
    ]) {
      await writeFile(join(directory, "pending-restart"), text);
      assert.equal(await marks.pending(), undefined, text);
    }
  }));

function journal(): {
  readonly failures: string[];
  drain: QueueDrain | undefined;
  saves: number;
  readonly save: () => Promise<void>;
} {
  const saved = {
    failures: ["run-a"],
    drain: { startedAt: 1, drainedAt: 2 } as QueueDrain | undefined,
    saves: 0,
    save: () => {
      saved.saves += 1;
      return Promise.resolve();
    },
  };
  return saved;
}

await test("CLV-306 the queue start clears the drain for a resume file and the failures too for a reset", () =>
  withDirectory(async (directory) => {
    const untouched = journal();
    await startedQueue({ directory }, untouched);
    assert.deepEqual(
      [untouched.drain, untouched.saves],
      [{ startedAt: 1, drainedAt: 2 }, 0],
    );
    await writeFile(join(directory, "resume-queue"), "");
    const resumed = journal();
    await startedQueue({ directory }, resumed);
    assert.deepEqual(
      [resumed.drain, resumed.failures, resumed.saves],
      [undefined, ["run-a"], 1],
    );
    const reset = journal();
    await startedQueue({ directory, resetQueue: true }, reset);
    assert.deepEqual(
      [reset.drain, reset.failures, reset.saves],
      [undefined, [], 1],
    );
    await mkdir(join(directory, "resume-queue"));
    await assert.rejects(startedQueue({ directory }, journal()));
  }));
