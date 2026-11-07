import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { restartMarks, startedQueue } from "../src/daemon/restart-marks.ts";
import type { QueueDrain } from "../src/queue-state.ts";
import {
  isRestartRequest,
  newestRestart,
  restartText,
} from "../src/restart-request.ts";

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

async function requestFile(directory: string): Promise<string> {
  const names = (await readdir(directory)).filter((name) =>
    name.startsWith("pending-restart-"),
  );
  assert.equal(names.length, 1, names.join(" "));
  return join(directory, String(names[0]));
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
    const file = await requestFile(directory);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), mark);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal(await marks.cancel(), "cancelled");
    assert.deepEqual(await readdir(directory), []);
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
      await requestFile(directory),
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
    await writeFile(join(directory, "pending-restart-bad"), "{");
    assert.equal(await marks.cancel(), "none");
    assert.equal(await marks.pending(), undefined);
  }));

await test("CLV-306 the daemon applies restart operations in the order of the calls", () =>
  withDirectory(async (directory) => {
    const marks = restartMarks(directory);
    const first = {
      at: "gap",
      requestedAt: 1_793_000_000_000,
      commandId: "one",
      resumeQueue: false,
    } as const;
    const second = { ...first, at: "now", commandId: "two" } as const;
    assert.deepEqual(
      await Promise.all([
        marks.pending(),
        marks.request(first),
        marks.pending(),
        marks.request(second),
        marks.pending(),
        marks.cancel(),
        marks.pending(),
      ]),
      [undefined, undefined, first, undefined, second, "cancelled", undefined],
    );
  }));

await test("CLV-306 a failed restart operation does not stop the operations after it", () =>
  withDirectory(async (directory) => {
    const missing = join(directory, "missing");
    const marks = restartMarks(missing);
    const mark = {
      at: "gap",
      requestedAt: 1_793_000_000_000,
      commandId: "one",
      resumeQueue: false,
    } as const;
    const failing = marks.request(mark);
    const later = marks.pending();
    await assert.rejects(failing, { code: "ENOENT" });
    assert.equal(await later, undefined);
    await mkdir(missing);
    await marks.request(mark);
    assert.deepEqual(await marks.pending(), mark);
  }));

await test("CLV-306 the newest valid request file wins while a replacement leaves two files", () => {
  const older = {
    at: "gap",
    requestedAt: 1_793_000_000_000,
    commandId: "one",
    resumeQueue: false,
  } as const;
  const newer = {
    ...older,
    at: "now",
    requestedAt: older.requestedAt + 1,
  } as const;
  const entries = [
    { name: "pending-restart-a", text: restartText(older) },
    { name: "pending-restart-b", text: restartText(newer) },
    { name: "pending-restart-c", text: "{" },
  ];
  const chosen = { name: "pending-restart-b", mark: newer };
  assert.deepEqual(newestRestart(entries), chosen);
  assert.deepEqual(newestRestart([...entries].reverse()), chosen);
  assert.equal(
    newestRestart([{ name: "pending-restart-c", text: "" }]),
    undefined,
  );
  assert.equal(isRestartRequest("pending-restart-a"), true);
  assert.equal(isRestartRequest("restart-a.tmp"), false);
});

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
      await writeFile(join(directory, "pending-restart-one"), text);
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

await test("CLV-306 the daemon reads the failure of an update that the host wrote", () =>
  withDirectory(async (directory) => {
    const marks = restartMarks(directory);
    assert.equal(await marks.failure(), undefined);
    const failure = {
      commandId: "one",
      requestedAt: 1_000,
      code: "restart-update-failed",
      step: "build",
      output: "broken",
    };
    const file = join(directory, "restart-failure");
    await writeFile(file, `${JSON.stringify(failure)}\n`);
    assert.deepEqual(await marks.failure(), failure);
    await writeFile(file, "{");
    assert.equal(await marks.failure(), undefined);
    await writeFile(file, JSON.stringify({ ...failure, step: 2 }));
    assert.equal(await marks.failure(), undefined);
    await writeFile(file, JSON.stringify({ ...failure, code: undefined }));
    assert.equal(await marks.failure(), undefined);
    for (const requestedAt of [undefined, 1.5, "1000"]) {
      await writeFile(file, JSON.stringify({ ...failure, requestedAt }));
      assert.equal(await marks.failure(), undefined);
    }
  }));

await test("CLV-320 a new restart request removes the failure note of an earlier restart", () =>
  withDirectory(async (directory) => {
    const marks = restartMarks(directory);
    const file = join(directory, "restart-failure");
    await writeFile(
      file,
      JSON.stringify({
        commandId: "earlier",
        requestedAt: 1_000,
        code: "restart-update-skipped",
        step: "clean",
        output: "?? notes.txt",
      }),
    );
    await marks.request({
      at: "gap",
      requestedAt: 2_000,
      commandId: "later",
      resumeQueue: false,
    });
    assert.equal(await marks.failure(), undefined);
    assert.equal((await marks.pending())?.commandId, "later");
  }));
