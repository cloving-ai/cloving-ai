import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { unresumableRuns } from "../src/daemon/unresumable-turns.ts";
import { restartText } from "../src/restart-request.ts";
import { hostedPrograms } from "../tools/self-host-processes.ts";
import { hostWorkReads, selfUpdateActive } from "../tools/self-update-host.ts";
import { record } from "../src/protocol.ts";
import { fresh, scripted, waitingOld } from "./restart-report-fixture.ts";
import { programs } from "./self-host-processes-fixture.ts";
import { eventually } from "./service-fixture.ts";

const operationId = JSON.stringify([
  "cloving-operation",
  1,
  "run-waiting",
  "implement",
  "claude-turn",
  null,
  null,
]);

const waiting = {
  harness: "claude",
  operationId,
  turnStartCommit: "0123456789abcdef0123456789abcdef01234567",
  startedAt: "2026-11-10T10:00:00.000Z",
  attempt: 1,
  phase: "waiting",
  processId: null,
  waitMilliseconds: 60000,
  waitingAt: "2026-11-10T10:01:00.000Z",
};

const endedAttempt = {
  attempt: 1,
  startedAt: "2026-11-10T10:00:00.000Z",
  endedAt: "2026-11-10T10:01:00.000Z",
  sessionId: null,
};

async function turnFolder(
  directory: string,
  turn: { readonly name: string; readonly started: unknown },
): Promise<string> {
  const folder = join(directory, "journal", turn.name);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "started.json"), JSON.stringify(turn.started));
  await writeFile(join(folder, "attempt-1.json"), JSON.stringify(endedAttempt));
  return folder;
}

async function withFolder(
  body: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "cloving-turn-wait-"));
  try {
    await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

await test("CLV-348 a turn in its retry wait holds neither a restart that keeps work nor a self-update", () =>
  withFolder(async (directory) => {
    const reads = hostWorkReads({ directory, runtimeDirectory: directory });
    await turnFolder(directory, { name: "waiting", started: waiting });
    assert.equal(await reads.heldTurn(), false);
    assert.equal(
      await selfUpdateActive({
        directory,
        runtimeDirectory: join(directory, "run"),
      }),
      false,
    );
  }));

await test("CLV-348 a waiting record with no valid attempt, wait start or wait length holds the restart", () =>
  withFolder(async (directory) => {
    const reads = hostWorkReads({ directory, runtimeDirectory: directory });
    for (const changed of [
      { attempt: 9 },
      { attempt: "1" },
      { waitingAt: undefined },
      { waitingAt: "not a time" },
      { waitMilliseconds: undefined },
      { waitMilliseconds: -1 },
      { waitMilliseconds: 1.5 },
      { waitMilliseconds: "60000" },
    ]) {
      const folder = await turnFolder(directory, {
        name: "held",
        started: { ...waiting, ...changed },
      });
      assert.equal(await reads.heldTurn(), true, JSON.stringify(changed));
      await rm(folder, { recursive: true });
    }
  }));

await test("CLV-348 a turn in its retry wait is not in the list of runs that cannot resume", () =>
  withFolder(async (directory) => {
    await turnFolder(directory, { name: "waiting", started: waiting });
    await turnFolder(directory, {
      name: "shell",
      started: {
        ...waiting,
        harness: "shell",
        operationId: operationId.replace("run-waiting", "run-shell"),
      },
    });
    assert.deepEqual(await unresumableRuns(directory), ["run-shell"]);
  }));

await test("CLV-348 a restart that keeps turns stops the programs at once while a turn waits for a capacity retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloving-turn-wait-host-"));
  const stopped = new AbortController();
  try {
    const paths = await programs(root, {
      statusRuns: [
        { runId: "run-waiting", workflowId: "develop", state: "running" },
      ],
    });
    const directory = join(root, "host");
    const folder = await turnFolder(directory, {
      name: "waiting",
      started: waiting,
    });
    const hosting = hostedPrograms({
      ...paths,
      repository: root,
      runtime: join(directory, "run"),
      directory,
      watchPort: "off",
      phoneRelay: "off",
      updateMilliseconds: undefined,
      restartMilliseconds: 50,
    });
    await eventually(() =>
      existsSync(join(root, "daemon-ready")) ? true : undefined,
    );
    await writeFile(
      join(directory, "pending-restart-one"),
      restartText({
        at: "keep",
        requestedAt: Date.now(),
        commandId: "restart-waiting",
        resumeQueue: false,
      }),
    );
    const held = delay(10_000, "held", { signal: stopped.signal }).catch(
      () => "stopped",
    );
    const first = await Promise.race([hosting, held]);
    await writeFile(join(folder, "result.json"), "{}");
    await hosting;
    assert.equal(first, 75);
    assert.equal(
      await readFile(join(root, "daemon-signals"), "utf8"),
      "SIGUSR2\n",
    );
  } finally {
    stopped.abort();
    await rm(root, { recursive: true, force: true });
  }
});

await test("CLV-348 the restart report lists the runs whose turns wait for a retry again", async () => {
  const done = {
    ...fresh,
    restart: null,
    workflows: ["develop", "nightly"],
    turnRecovery: {
      state: "done",
      connected: [],
      resumed: [],
      waiting: ["run-e", "run-f"],
      commands: [],
    },
  };
  const result = await scripted({ statuses: [waitingOld, done] });
  assert.equal(result.code, 0, result.error);
  assert.match(result.out, /^Turns that wait for a retry: run-e, run-f$/m);
  const json = await scripted({
    statuses: [waitingOld, done],
    invocation: { json: true },
  });
  const [, restarted] = json.out
    .trim()
    .split("\n")
    .map((line) => record(JSON.parse(line)));
  assert.deepEqual(restarted?.["turns"], {
    connected: [],
    resumed: [],
    waiting: ["run-e", "run-f"],
    commands: [],
  });
});

await test("CLV-348 the README Restart section says that a turn in its retry wait keeps its wait", async () => {
  const readme = await readFile(
    new URL("../README.md", import.meta.url),
    "utf8",
  );
  const restart = readme.slice(
    readme.indexOf("### Restart"),
    readme.indexOf("## Continuous process"),
  );
  assert.match(
    restart,
    /A turn that waits for a retry keeps its wait through a restart\./,
  );
  assert.match(restart, /waits for the time that remains/);
  assert.match(restart, /the next attempt starts at once/);
  assert.match(restart, /`Turns that wait for a retry: <runs>`/);
  assert.match(restart, /`turnWaits`/);
  assert.doesNotMatch(restart, /a turn that waits for a retry still stop/);
  assert.doesNotMatch(
    restart,
    /a turn that waits for a retry, or a turn that does not keep/,
  );
});
