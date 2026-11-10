import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  attachedTurn,
  detachedTurn,
  launchState,
} from "../src/daemon/detached-turn.ts";
import { recordedLaunch, type TurnLaunch } from "../src/turn-launch.ts";
import {
  processExists,
  processIdentity,
} from "../src/daemon/process-identity.ts";
import { until } from "./claude-worker-fixture.ts";

const holding = `process.stdout.write(JSON.stringify({ type: "system", session_id: "session-7" }) + "\\n"); process.on("SIGTERM", () => require("node:fs").writeFileSync(process.argv[1], "")); setInterval(() => {}, 1000);`;

async function withFolder(
  use: (folder: string) => Promise<void>,
): Promise<void> {
  const folder = mkdtempSync(join(tmpdir(), "cloving-detached-"));
  try {
    await use(folder);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

function started(folder: string, script: string) {
  const configuration = join(folder, "gh-config");
  mkdirSync(configuration);
  return detachedTurn({
    command: ["fake"],
    executable: process.execPath,
    arguments: ["-e", script, join(folder, "terminated")],
    environment: { PATH: process.env["PATH"] ?? "" },
    directory: folder,
    folder,
    standardInput: undefined,
    configuration,
  });
}

async function launchOf(turn: {
  readonly launch: Promise<TurnLaunch | null>;
}): Promise<TurnLaunch> {
  const launch = await turn.launch;
  assert.ok(launch);
  return launch;
}

async function withFailedProcessList<Used>(
  folder: string,
  use: () => Promise<Used>,
): Promise<Used> {
  const tools = join(folder, "tools");
  mkdirSync(tools);
  writeFileSync(join(tools, "ps"), "#!/bin/sh\nexit 2\n", { mode: 0o700 });
  const path = process.env["PATH"] ?? "";
  process.env["PATH"] = `${tools}:${path}`;
  try {
    return await use();
  } finally {
    process.env["PATH"] = path;
  }
}

function killed(processId: number): Promise<void> {
  process.kill(-processId, "SIGKILL");
  return until(() => !processExists(processId));
}

await test("CLV-337 a recorded launch needs a positive process ID, an offset and each text", () => {
  const complete = {
    processId: 7,
    processStart: "Tue Nov 10 02:24:00 2026",
    marker: "cloving-turn-1",
    output: "/journal/turn.jsonl",
    offset: 0,
    exit: "/journal/turn.exit.json",
    configuration: "/journal/gh-config-1",
  };
  assert.deepEqual(recordedLaunch(complete), complete);
  for (const broken of [
    undefined,
    { ...complete, processId: "7" },
    { ...complete, processId: 1.5 },
    { ...complete, processId: 0 },
    { ...complete, offset: "0" },
    { ...complete, marker: null },
  ])
    assert.equal(recordedLaunch(broken), undefined);
});

await test("CLV-337 the identity of a process is its start time and command, and a missing process has none", async () => {
  assert.equal(processExists(1), true);
  assert.equal(await processIdentity(2 ** 22 + 1), undefined);
  const identity = await processIdentity(process.pid);
  assert.ok(identity);
  assert.ok(identity.command.includes(process.execPath));
});

await test("CLV-337 a launch is running while its process lives, then gone when it dies with no exit file", () =>
  withFolder(async (folder) => {
    const turn = started(folder, holding);
    const launch = await launchOf(turn);
    assert.equal(await launchState(launch), "running");
    assert.equal(
      await launchState({ ...launch, marker: "cloving-turn-other" }),
      "gone",
    );
    await killed(launch.processId);
    await turn.ended;
    assert.equal(await launchState(launch), "gone");
  }));

await test("CLV-337 an attached turn whose process dies with no exit file ends with no exit code and keeps the lines that it read", () =>
  withFolder(async (folder) => {
    const turn = started(folder, holding);
    const launch = await launchOf(turn);
    const release = new AbortController();
    const kept = attachedTurn({ command: ["fake"] }, launch);
    const released = attachedTurn(
      { command: ["fake"], release: release.signal },
      launch,
    );
    release.abort();
    assert.equal(await released.exited, "released");
    await assert.rejects(released.ended, /turn-released/);
    released.stop(0);
    await killed(launch.processId);
    const end = await kept.ended;
    assert.equal(end.exitCode, null);
    assert.equal(end.result, undefined);
    assert.equal(await kept.exited, "exited");
    assert.equal(existsSync(launch.configuration), false);
    await turn.ended;
  }));

await test("CLV-337 an attached turn does not signal a different process with the recorded process ID", () =>
  withFolder(async (folder) => {
    const other = spawn(
      process.execPath,
      ["-e", holding, join(folder, "other")],
      {
        detached: true,
        stdio: "ignore",
      },
    );
    try {
      const processId = other.pid ?? 0;
      const identity = await processIdentity(processId);
      assert.ok(identity);
      const launch: TurnLaunch = {
        processId,
        processStart: identity.start,
        marker: "cloving-turn-gone",
        output: join(folder, "turn.jsonl"),
        offset: 0,
        exit: join(folder, "turn.exit.json"),
        configuration: join(folder, "gh-config"),
      };
      const turn = attachedTurn({ command: ["fake"] }, launch);
      assert.deepEqual(await turn.ended, { exitCode: null, result: undefined });
      turn.stop(0);
      await delay(500);
      assert.equal(existsSync(join(folder, "other")), false);
      assert.equal(processExists(processId), true);
    } finally {
      other.kill("SIGKILL");
    }
  }));

await test("CLV-337 a launch whose process lives while its identity cannot be read stays running", () =>
  withFolder(async (folder) => {
    const turn = started(folder, holding);
    const launch = await launchOf(turn);
    await withFailedProcessList(folder, async () => {
      assert.equal(await launchState(launch), "running");
    });
    await killed(launch.processId);
    await turn.ended;
  }));

await test("CLV-337 an attached turn waits and sends no signal while the identity of its live process cannot be read", () =>
  withFolder(async (folder) => {
    const turn = started(folder, holding);
    const launch = await launchOf(turn);
    await withFailedProcessList(folder, async () => {
      const kept = attachedTurn({ command: ["fake"] }, launch);
      const early = await Promise.race([
        kept.ended.then(() => "ended"),
        delay(1500).then(() => "waiting"),
      ]);
      assert.equal(early, "waiting");
      kept.stop(0);
      await delay(300);
      assert.equal(existsSync(join(folder, "terminated")), false);
      assert.equal(processExists(launch.processId), true);
      writeFileSync(launch.exit, JSON.stringify({ exitCode: 3 }));
      assert.equal((await kept.ended).exitCode, 3);
    });
    await killed(launch.processId);
    await turn.ended;
  }));

await test("CLV-337 an attached turn keeps its stop request while the identity of its live process cannot be read, then sends it", () =>
  withFolder(async (folder) => {
    const turn = started(folder, holding);
    const launch = await launchOf(turn);
    const kept = await withFailedProcessList(folder, async () => {
      const attached = attachedTurn({ command: ["fake"] }, launch);
      attached.stop(1500);
      await delay(400);
      assert.equal(existsSync(join(folder, "terminated")), false);
      return attached;
    });
    await until(() => existsSync(join(folder, "terminated")));
    assert.equal((await kept.ended).exitCode, null);
    assert.equal(processExists(launch.processId), false);
    await turn.ended;
  }));
