import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  queueConnection,
  queueControlPort,
} from "../src/daemon/queue-control.ts";
import { queueJournal } from "../src/daemon/queue-journal.ts";
import { queueStateFields } from "../src/queue-state.ts";

async function withDirectory(
  body: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "cloving-queue-control-"));
  try {
    await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function loaded(
  directory: string,
): Promise<ReturnType<typeof queueControlPort>> {
  return queueControlPort({
    pending: await queueJournal(directory),
    error: undefined,
    stopping: new AbortController(),
  });
}

await test("CLV-273 a queue command ID replays its first command after a restart and refuses another command", () =>
  withDirectory(async (directory) => {
    const port = await loaded(directory);
    assert.deepEqual(
      await port.change({ command: "drain", commandId: "one" }),
      {
        kind: "changed",
      },
    );
    assert.deepEqual(
      await port.change({ command: "resume", commandId: "two" }),
      { kind: "changed" },
    );
    assert.deepEqual(
      await port.change({ command: "drain", commandId: "one" }),
      {
        kind: "replayed",
      },
    );
    assert.equal(port.control()?.drain, undefined);
    assert.deepEqual(
      await port.change({ command: "resume", commandId: "one" }),
      { kind: "conflicting-command" },
    );
    const restarted = await loaded(directory);
    assert.deepEqual(
      await restarted.change({ command: "drain", commandId: "one" }),
      { kind: "replayed" },
    );
    assert.equal(restarted.control()?.drain, undefined);
  }));

await test("CLV-273 the queue journal keeps the newest 32 queue command IDs", () =>
  withDirectory(async (directory) => {
    const port = await loaded(directory);
    for (let index = 0; index < 33; index += 1)
      await port.change({
        command: "resume",
        commandId: `resume-${String(index)}`,
      });
    const saved: unknown = JSON.parse(
      await readFile(join(directory, "queue-commands.json"), "utf8"),
    );
    assert.ok(saved !== null && typeof saved === "object");
    const controls: unknown = Reflect.get(saved, "controls");
    assert.ok(Array.isArray(controls));
    assert.equal(controls.length, 32);
    assert.deepEqual(controls[0], { commandId: "resume-1", command: "resume" });
    assert.deepEqual(
      await port.change({ command: "drain", commandId: "resume-0" }),
      { kind: "changed" },
    );
  }));

await test("CLV-273 the queue journal refuses an invalid drain or queue command record", () =>
  withDirectory(async (directory) => {
    const file = join(directory, "queue-commands.json");
    for (const saved of [
      { drain: { startedAt: 0, drainedAt: null } },
      { drain: { startedAt: 1, drainedAt: "later" } },
      { drain: "draining" },
      { controls: "resume" },
      { controls: [{ commandId: "", command: "resume" }] },
      { controls: [{ commandId: "one", command: "pause" }] },
      {
        controls: Array.from({ length: 33 }, (_, index) => ({
          commandId: `resume-${String(index)}`,
          command: "resume",
        })),
      },
    ]) {
      await writeFile(
        file,
        JSON.stringify({ commands: [], failures: [], ...saved }),
      );
      await assert.rejects(queueJournal(directory), /invalid-queue-commands/);
    }
  }));

await test("CLV-273 a queue that is not loaded or not connected refuses queue commands", async () => {
  const connection = queueConnection();
  assert.equal(connection.port.control(), undefined);
  const refusal = { kind: "unavailable", detail: "The queue is not running." };
  assert.deepEqual(
    await connection.port.change({ command: "drain", commandId: "early" }),
    refusal,
  );
  const unloaded = queueControlPort({
    pending: undefined,
    error: undefined,
    stopping: new AbortController(),
  });
  connection.connect(unloaded);
  assert.equal(connection.port.control(), undefined);
  assert.deepEqual(
    await connection.port.change({ command: "resume", commandId: "early" }),
    refusal,
  );
});

await test("CLV-273 a queue that stopped on an error shows the reason and refuses queue commands", async () => {
  const port = queueControlPort({
    pending: undefined,
    error: "invalid-queue-commands",
    stopping: new AbortController(),
  });
  assert.deepEqual(port.control(), {
    failedRunIds: [],
    drain: undefined,
    error: "invalid-queue-commands",
  });
  assert.deepEqual(
    await port.change({ command: "resume", commandId: "late" }),
    {
      kind: "unavailable",
      detail: "The queue stopped: invalid-queue-commands. Restart the service.",
    },
  );
});

await test("CLV-273 an error stop takes precedence over a drain and a drain over a failure stop", () => {
  const drain = { startedAt: 1, drainedAt: null };
  const failedRunIds = ["one", "two", "three"];
  assert.equal(
    queueStateFields({ failedRunIds, drain, error: "invalid-run-list" }, 0)[
      "state"
    ],
    "stopped",
  );
  const draining = queueStateFields(
    { failedRunIds, drain, error: undefined },
    1,
  );
  assert.equal(draining["state"], "draining");
  assert.deepEqual(draining["stop"], { reason: "failure-limit" });
  assert.equal(
    queueStateFields(
      { failedRunIds: [], drain: undefined, error: undefined },
      1,
    )["state"],
    "running",
  );
});

await test("CLV-273 a drain stays draining until the queue records the drain time and while a manual run is busy", () => {
  const control = (drainedAt: number | null) => ({
    failedRunIds: [],
    drain: { startedAt: 1, drainedAt },
    error: undefined,
  });
  assert.equal(queueStateFields(control(null), 0)["state"], "draining");
  assert.equal(queueStateFields(control(2), 0)["state"], "drained");
  assert.equal(queueStateFields(control(2), 1)["state"], "draining");
});

await test("CLV-273 a queue command that the journal cannot save stops the queue and its command ID does not replay", () =>
  withDirectory(async (directory) => {
    const stopping = new AbortController();
    const port = queueControlPort({
      pending: await queueJournal(directory),
      error: undefined,
      stopping,
    });
    await rm(directory, { recursive: true, force: true });
    const settled = await Promise.allSettled([
      port.change({ command: "drain", commandId: "one" }),
      port.change({ command: "drain", commandId: "one" }),
    ]);
    const changes = settled.map((outcome) =>
      outcome.status === "fulfilled" ? outcome.value : { kind: "rejected" },
    );
    assert.deepEqual(
      changes.map((change) => change.kind),
      ["unavailable", "unavailable"],
    );
    for (const change of changes)
      assert.match(
        "detail" in change ? change.detail : "",
        /^The queue stopped: ENOENT.*\. Restart the service\.$/,
      );
    assert.equal(stopping.signal.aborted, true);
    const control = port.control();
    assert.ok(control !== undefined);
    assert.match(String(control.error), /^ENOENT/);
    assert.equal(queueStateFields(control, 0)["state"], "stopped");
  }));
