import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { parseInvocation } from "../src/cli/arguments.ts";
import { commandUsage } from "../src/cli/usage.ts";
import { record } from "../src/protocol.ts";
import { restartMark, restartText } from "../src/restart-request.ts";
import { turnRecoveries } from "../src/turn-recovery.ts";
import { heldWork, type KeepReads } from "../src/work-gap.ts";
import { hostedPrograms } from "../tools/self-host-processes.ts";
import { hostWorkReads, selfUpdateActive } from "../tools/self-update-host.ts";
import { fresh, old, scripted, waitingOld } from "./restart-report-fixture.ts";
import { programs } from "./self-host-processes-fixture.ts";
import { call, eventually, withHarness } from "./service-fixture.ts";

const launch = {
  processId: 4242,
  processStart: "Tue Nov 10 10:00:00 2026",
  marker: "cloving-turn-marker",
  output: "turn.jsonl",
  offset: 0,
  exit: "turn.exit.json",
  configuration: "configuration",
};

async function turnFolder(
  directory: string,
  turn: {
    readonly name: string;
    readonly started: unknown;
    readonly attempt?: unknown;
    readonly result?: true;
  },
): Promise<string> {
  const folder = join(directory, "journal", turn.name);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "started.json"), JSON.stringify(turn.started));
  if (turn.attempt !== undefined)
    await writeFile(
      join(folder, "attempt-1.json"),
      JSON.stringify(turn.attempt),
    );
  if (turn.result === true) await writeFile(join(folder, "result.json"), "{}");
  return folder;
}

const openEntry = { attempt: 1, startedAt: "2026-11-10T10:00:00.000Z" };

const keptTurn = {
  name: "kept",
  started: { phase: "running", attempt: 1, launch },
  attempt: openEntry,
};

async function withFolder(
  body: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "cloving-restart-keep-"));
  try {
    await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function keepReads(flags: {
  readonly heldTurn?: true;
  readonly openCommand?: true;
  readonly pendingSubmission?: true;
}): KeepReads {
  return {
    heldTurn: () => Promise.resolve(flags.heldTurn === true),
    openCommand: () => Promise.resolve(flags.openCommand === true),
    pendingSubmission: () => Promise.resolve(flags.pendingSubmission === true),
  };
}

await test("CLV-337 cloving restart keeps turns by default and accepts --at keep, gap and now", () => {
  assert.equal(record(parseInvocation(["restart"]))?.["at"], "keep");
  for (const at of ["keep", "gap", "now"])
    assert.equal(record(parseInvocation(["restart", "--at", at]))?.["at"], at);
  assert.match(String(commandUsage["restart"]), /--at keep\|gap\|now/);
  assert.equal(
    restartMark(
      restartText({
        at: "keep",
        requestedAt: 1,
        commandId: "restart-keep",
        resumeQueue: false,
      }),
    )?.at,
    "keep",
  );
});

await test("CLV-337 only a turn that cannot keep running, an open command or a pending submission holds a restart that keeps turns", async () => {
  assert.deepEqual(await heldWork(keepReads({})), []);
  assert.deepEqual(
    await heldWork(
      keepReads({ heldTurn: true, openCommand: true, pendingSubmission: true }),
    ),
    [
      "A worker turn cannot keep running.",
      "A command effect is open.",
      "A queue submission is pending.",
    ],
  );
});

await test("CLV-337 the host holds the restart for an open turn with no launch, a waiting turn, an ended attempt and an open command", () =>
  withFolder(async (directory) => {
    const reads = hostWorkReads({ directory, runtimeDirectory: directory });
    assert.equal(await reads.heldTurn(), false);
    assert.equal(await reads.openCommand(), false);
    await turnFolder(directory, keptTurn);
    await turnFolder(directory, {
      name: "ended",
      started: { phase: "running", attempt: 1 },
      result: true,
    });
    assert.equal(await reads.heldTurn(), false);
    for (const held of [
      { started: { phase: "running", attempt: 1 }, attempt: openEntry },
      { started: { phase: "waiting", attempt: 1, launch }, attempt: openEntry },
      {
        started: { phase: "running", attempt: 1, launch },
        attempt: { ...openEntry, endedAt: "2026-11-10T10:01:00.000Z" },
      },
      { started: { phase: "running", attempt: 1, launch } },
      { started: { phase: "running", attempt: 1, launch }, attempt: {} },
      { started: { phase: "running", attempt: 9, launch }, attempt: openEntry },
      {
        started: { phase: "running", attempt: 1, launch: { processId: 1 } },
        attempt: openEntry,
      },
    ]) {
      const folder = await turnFolder(directory, { name: "held", ...held });
      assert.equal(await reads.heldTurn(), true, JSON.stringify(held));
      await rm(folder, { recursive: true });
    }
    const command = join(directory, "commands", "command-one");
    await mkdir(command, { recursive: true });
    assert.equal(await reads.openCommand(), false);
    await writeFile(join(command, "started.json"), "{}");
    assert.equal(await reads.openCommand(), true);
    await writeFile(join(command, "result.json"), "{}");
    assert.equal(await reads.openCommand(), false);
  }));

await test("CLV-337 the self-update waits only for a turn that cannot keep running", () =>
  withFolder(async (directory) => {
    const settings = { directory, runtimeDirectory: join(directory, "run") };
    await turnFolder(directory, keptTurn);
    assert.equal(await selfUpdateActive(settings), false);
    await turnFolder(directory, {
      name: "codex",
      started: { phase: "running", attempt: 1 },
      attempt: openEntry,
    });
    assert.equal(await selfUpdateActive(settings), true);
  }));

async function withKeepHost(
  body: (scene: {
    readonly root: string;
    readonly directory: string;
    readonly hosting: Promise<number>;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "cloving-restart-keep-host-"));
  try {
    const paths = await programs(root, {
      statusRuns: [
        { runId: "run-busy", workflowId: "develop", state: "running" },
      ],
    });
    const directory = join(root, "host");
    await mkdir(directory, { recursive: true });
    await turnFolder(directory, keptTurn);
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
    await body({ root, directory, hosting });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function keepMark(commandId: string): string {
  return restartText({
    at: "keep",
    requestedAt: Date.now(),
    commandId,
    resumeQueue: false,
  });
}

await test("CLV-337 a restart that keeps turns stops the programs at once with an active run and a kept turn", () =>
  withKeepHost(async ({ root, directory, hosting }) => {
    await writeFile(
      join(directory, "pending-restart-one"),
      keepMark("restart-keep"),
    );
    assert.equal(await hosting, 75);
    assert.equal(
      await readFile(join(root, "daemon-signals"), "utf8"),
      "SIGUSR2\n",
    );
  }));

await test("CLV-337 a restart that keeps turns waits for an open command and a turn that cannot keep running", () =>
  withKeepHost(async ({ root, directory, hosting }) => {
    const command = join(directory, "commands", "command-one");
    await mkdir(command, { recursive: true });
    await writeFile(join(command, "started.json"), "{}");
    const held = await turnFolder(directory, {
      name: "codex",
      started: { phase: "running", attempt: 1 },
      attempt: openEntry,
    });
    await writeFile(
      join(directory, "pending-restart-one"),
      keepMark("restart-held"),
    );
    await delay(400);
    assert.equal(existsSync(join(root, "daemon-signals")), false);
    await writeFile(join(command, "result.json"), "{}");
    await delay(400);
    assert.equal(existsSync(join(root, "daemon-signals")), false);
    await writeFile(join(held, "result.json"), "{}");
    assert.equal(await hosting, 75);
  }));

await test("CLV-337 the status shows the turns that the new service connected to and the turns that it resumed", () =>
  withHarness(async (harness) => {
    const recoveries = turnRecoveries();
    await harness.start({ turnRecovery: recoveries });
    const status = { operation: "status", parameters: { limit: 1 } };
    assert.deepEqual((await call(harness, status))["turnRecovery"], {
      state: "recovering",
      connected: [],
      resumed: [],
    });
    recoveries.note({ runId: "run-b", way: "connected" });
    recoveries.note({ runId: "run-a", way: "connected" });
    recoveries.note({ runId: "run-c", way: "resumed" });
    recoveries.note({ runId: "run-a", way: "connected" });
    recoveries.finish();
    assert.deepEqual((await call(harness, status))["turnRecovery"], {
      state: "done",
      connected: ["run-a", "run-b"],
      resumed: ["run-c"],
    });
  }));

function recovery(state: string, connected: readonly string[]) {
  return {
    ...fresh,
    restart: null,
    workflows: ["develop", "nightly"],
    turnRecovery: { state, connected, resumed: ["run-c"] },
  };
}

await test("CLV-337 the restart waits for the end of the turn recovery and lists the turns that the new service connected to and resumed", async () => {
  const recovering = recovery("recovering", ["run-a"]);
  const done = recovery("done", ["run-a", "run-b"]);
  const result = await scripted({
    statuses: [waitingOld, recovering, recovering, done],
  });
  assert.equal(result.code, 0, result.error);
  assert.equal(
    result.out,
    [
      "Restart pending: 0 runs active",
      `Restarted: commit ${old.serviceCommit} -> ${fresh.serviceCommit}`,
      `Started at: ${fresh.serviceStartedAt}`,
      "Workflow develop: admitted",
      "Workflow nightly: admitted",
      "Turns connected again: run-a, run-b",
      "Turns resumed: run-c",
      "",
    ].join("\n"),
  );
  const json = await scripted({
    statuses: [waitingOld, done],
    invocation: { json: true },
  });
  const [, restarted] = json.out
    .trim()
    .split("\n")
    .map((line) => record(JSON.parse(line)));
  assert.deepEqual(restarted?.["turns"], {
    connected: ["run-a", "run-b"],
    resumed: ["run-c"],
  });
});

await test("CLV-337 a turn recovery that does not end within the start limit still gives the report", async () => {
  const result = await scripted({
    statuses: [waitingOld, recovery("recovering", ["run-a"])],
  });
  assert.equal(result.code, 0, result.error);
  assert.match(result.out, /^Turns connected again: run-a$/m);
});
