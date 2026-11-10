import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  attachedTurn,
  detachedTurn,
  launchState,
  recordedLaunch,
  type TurnLaunch,
} from "../src/daemon/detached-turn.ts";
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
