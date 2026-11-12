import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  alive,
  field,
  intent,
  journalKey,
  record,
  until,
  withScene,
  type Scene,
} from "./claude-worker-fixture.ts";
import type { TurnRecovery } from "../src/turn-recovery.ts";
import { activeOwners } from "../src/daemon/turn-owners.ts";
import { stopLeftProcesses } from "../src/daemon/worktree-processes.ts";
import {
  crashedService,
  markedProcess,
  withFailedSearches,
} from "./crashed-service-fixture.ts";

const signal = new AbortController().signal;

const crashing = `
const [moduleUrl, settingsText] = process.argv.slice(1);
const { claudeWorker } = await import(moduleUrl);
const { intent, ...settings } = JSON.parse(settingsText);
const worker = claudeWorker({
  ...settings,
  document: (digest) => Promise.resolve("prompt of " + digest),
  report: () => Promise.resolve(),
  stopMilliseconds: 100,
  turnSettings: () => ({ profiles: {}, fallbackModels: [], tokenPrices: {} }),
});
await worker.deliver(intent, new AbortController().signal);
setInterval(() => undefined, 1000);
`;

async function crashedTurn(scene: Scene, mode: string): Promise<void> {
  await crashedService({
    directory: scene.directory,
    source: crashing,
    arguments: [
      new URL("../src/daemon/claude-worker.ts", import.meta.url).href,
      JSON.stringify({
        repository: scene.repository,
        worktrees: scene.worktrees,
        journal: scene.journal,
        command: [
          "env",
          "-u",
          "NODE_V8_COVERAGE",
          process.execPath,
          join(scene.directory, "fake-claude.mjs"),
          mode,
          join(scene.directory, "turns.log"),
        ],
        intent: intent(),
      }),
    ],
    started: () => scene.turns().length === 1,
  });
  const started = record(scene, "operation-1/started.json");
  assert.equal(field(started, "phase"), "starting");
  assert.equal(field(started, "launch"), undefined);
}

await test("CLV-350 a new worker connects to a turn whose service stopped before its launch record, and does not resume it", () =>
  withScene(async (scene) => {
    await crashedTurn(scene, "gated-lines");
    const noted: TurnRecovery[] = [];
    const next = scene.worker("gated-lines", {
      recovered: (recovery) => noted.push(recovery),
    });
    assert.equal((await next.reconcile(intent(), signal)).kind, "accepted");
    assert.deepEqual(noted, [{ runId: "run-1", way: "connected" }]);
    writeFileSync(join(scene.directory, "turns.log.gate"), "");
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "completed");
    assert.equal(scene.turns().length, 1);
  }));

function keptTurn(scene: Scene) {
  const [turn] = scene.turns();
  assert.ok(turn);
  return turn;
}

function plannedMarker(scene: Scene): string {
  const planned: unknown = JSON.parse(
    readFileSync(
      join(scene.journal, journalKey("operation-1"), "launch-marker.json"),
      "utf8",
    ),
  );
  return String(field(planned, "marker"));
}

await test("CLV-350 a new worker stops the turn and each other process with its marker when more than one matches, and the turn is interrupted", () =>
  withScene(async (scene) => {
    await crashedTurn(scene, "gated-lines");
    const other = markedProcess(scene.directory, plannedMarker(scene));
    try {
      await until(other.known);
      const next = scene.worker("gated-lines", { stopMilliseconds: 3000 });
      const reply = await next.reconcile(intent(), signal);
      assert.deepEqual(
        [reply.kind, field(reply, "reason")],
        ["failed", "claude-turn-interrupted"],
      );
      const turn = keptTurn(scene);
      assert.equal(alive(turn.processId), false);
      assert.equal(alive(turn.parentId), false);
      assert.equal(alive(other.processId), false);
      assert.equal(scene.turns().length, 1);
    } finally {
      other.close();
    }
  }));

await test("CLV-350 a turn with a marker and no matching process is not connected", () =>
  withScene(async (scene) => {
    await crashedTurn(scene, "sessionless");
    const turn = keptTurn(scene);
    process.kill(-turn.parentId, "SIGKILL");
    await until(() => !alive(turn.processId) && !alive(turn.parentId));
    const noted: TurnRecovery[] = [];
    const next = scene.worker("gated-lines", {
      recovered: (recovery) => noted.push(recovery),
    });
    const reply = await next.reconcile(intent(), signal);
    assert.deepEqual(
      [reply.kind, field(reply, "reason")],
      ["failed", "claude-turn-interrupted"],
    );
    assert.deepEqual(noted, []);
    assert.equal(scene.turns().length, 1);
  }));

await test("CLV-350 a failed process search keeps the turn in recovery, does not resume it, and a later reconcile connects to it", () =>
  withScene(async (scene) => {
    await crashedTurn(scene, "gated-lines");
    const noted: TurnRecovery[] = [];
    const next = scene.worker("gated-lines", {
      recovered: (recovery) => noted.push(recovery),
    });
    const reply = await withFailedSearches(scene.directory, () =>
      next.reconcile(intent(), signal),
    );
    assert.deepEqual(reply, {
      kind: "unknown",
      evidence: `claude-turn:${journalKey("operation-1")}`,
    });
    assert.deepEqual(noted, []);
    assert.equal(scene.turns().length, 1);
    assert.equal((await next.reconcile(intent(), signal)).kind, "accepted");
    assert.deepEqual(noted, [{ runId: "run-1", way: "connected" }]);
    writeFileSync(join(scene.directory, "turns.log.gate"), "");
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "completed");
    assert.equal(scene.turns().length, 1);
  }));

await test("CLV-350 a new worker holds a turn that it finds by its marker before any recovery, so the cleanup of another run in the same work tree does not stop it", () =>
  withScene(async (scene) => {
    await crashedTurn(scene, "gated-lines");
    const turn = keptTurn(scene);
    const owner = { runId: "run-1", processId: turn.parentId };
    const next = scene.worker("gated-lines");
    await next.hold(intent());
    assert.deepEqual(await activeOwners(turn.directory), [owner]);
    await stopLeftProcesses({
      directory: turn.directory,
      runId: "run-2",
      seconds: 60,
      signal,
      stopMilliseconds: 100,
    });
    assert.equal(alive(turn.processId), true);
    assert.equal(alive(turn.parentId), true);
    assert.equal((await next.reconcile(intent(), signal)).kind, "accepted");
    assert.deepEqual(await activeOwners(turn.directory), [owner]);
    writeFileSync(join(scene.directory, "turns.log.gate"), "");
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "completed");
    assert.equal(scene.turns().length, 1);
  }));
