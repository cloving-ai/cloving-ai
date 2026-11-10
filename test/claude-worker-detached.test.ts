import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { record } from "../src/protocol.ts";
import {
  alive,
  field,
  intent,
  journalKey,
  priorProcess,
  record as journalRecord,
  resultOf,
  until,
  withScene,
  type Scene,
} from "./claude-worker-fixture.ts";

const signal = new AbortController().signal;
const folder = (scene: Scene): string =>
  join(scene.journal, journalKey("operation-1"));
const opened = (scene: Scene): void => {
  writeFileSync(join(scene.directory, "turns.log.gate"), "");
};

function processGroup(processId: number): number {
  return Number(
    execFileSync("ps", ["-o", "pgid=", "-p", String(processId)], {
      encoding: "utf8",
    }).trim(),
  );
}

function lineNumbers(scene: Scene): readonly number[] {
  const path = join(folder(scene), "turn.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .flatMap((line) => /"text":"line (\d+)"/.exec(line)?.[1] ?? [])
    .map(Number);
}

function sessionKnown(scene: Scene): boolean {
  return (
    field(journalRecord(scene, "operation-1/attempt-1.json"), "sessionId") ===
    "session-1"
  );
}

function keptTurn(scene: Scene): { processId: number; parentId: number } {
  const [turn] = scene.turns();
  assert.ok(turn);
  return turn;
}

function stoppedGroup(scene: Scene): Promise<void> {
  const turn = keptTurn(scene);
  process.kill(-turn.parentId, "SIGKILL");
  return until(() => !alive(turn.processId) && !alive(turn.parentId));
}

await test("CLV-337 a turn writes its output to files in its own process group", () =>
  withScene(async (scene) => {
    await scene.worker("gated-lines").deliver(intent(), signal);
    await until(() => scene.turns().length === 1);
    const turn = keptTurn(scene);
    const started = journalRecord(scene, "operation-1/started.json");
    const launch = field(started, "launch");
    const [line = ""] = readFileSync(
      join(scene.directory, "turns.log"),
      "utf8",
    ).split("\n");
    assert.equal(field(JSON.parse(line), "outputFile"), true);
    assert.deepEqual(
      [field(started, "processId"), field(launch, "processId")],
      [turn.parentId, turn.parentId],
    );
    assert.equal(typeof field(launch, "processStart"), "string");
    assert.match(String(field(launch, "marker")), /^cloving-turn-/);
    assert.equal(processGroup(turn.processId), turn.parentId);
    assert.notEqual(processGroup(turn.processId), processGroup(process.pid));
    opened(scene);
    await until(() => scene.reports.length === 1);
    const ending: unknown = JSON.parse(
      readFileSync(join(folder(scene), "turn.exit.json"), "utf8"),
    );
    assert.equal(field(ending, "exitCode"), 0);
    assert.equal(typeof field(ending, "endedAt"), "string");
    assert.equal(scene.reports[0]?.outcome, "completed");
  }));

await test("CLV-337 a new worker connects to a running turn and reads each line one time", () =>
  withScene(async (scene) => {
    const first = scene.worker("gated-lines");
    await first.deliver(intent(), signal);
    await until(() => lineNumbers(scene).length >= 5);
    await first.close({ turns: "keep" });
    const turn = keptTurn(scene);
    assert.equal(alive(turn.processId), true);
    assert.equal(journalRecord(scene, "operation-1/result.json"), undefined);
    const before = lineNumbers(scene).length;
    await until(() => lineNumbers(scene).length > before + 5);
    const next = scene.worker("gated-lines");
    assert.equal((await next.reconcile(intent(), signal)).kind, "accepted");
    assert.equal(alive(turn.processId), true);
    opened(scene);
    await until(() => scene.reports.length === 1);
    const numbers = lineNumbers(scene);
    assert.deepEqual(
      numbers,
      numbers.map((_, index) => index + 1),
    );
    assert.equal(scene.turns().length, 1);
    assert.equal(scene.reports[0]?.outcome, "completed");
    assert.equal(resultOf(scene.reports[0].result)["costUsd"], 0.25);
  }));

await test("CLV-337 a turn that ends while no worker runs ends after the start", () =>
  withScene(async (scene) => {
    const first = scene.worker("gated-result");
    await first.deliver(intent(), signal);
    await until(() => sessionKnown(scene));
    await first.close({ turns: "keep" });
    opened(scene);
    await until(() => existsSync(join(folder(scene), "turn.exit.json")));
    assert.equal(alive(keptTurn(scene).processId), false);
    assert.equal(journalRecord(scene, "operation-1/result.json"), undefined);
    const next = scene.worker("gated-result");
    assert.equal((await next.reconcile(intent(), signal)).kind, "accepted");
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "completed");
    assert.equal(
      resultOf(scene.reports[0].result)["summary"],
      "Ticket status: complete",
    );
    assert.equal(scene.turns().length, 1);
  }));

await test("CLV-337 a turn process killed while no worker runs falls back to the session resume", () =>
  withScene(async (scene) => {
    const first = scene.worker("crash-once");
    await first.deliver(intent(), signal);
    await until(() => sessionKnown(scene));
    await first.close({ turns: "keep" });
    await stoppedGroup(scene);
    const next = scene.worker("crash-once");
    assert.equal((await next.reconcile(intent(), signal)).kind, "accepted");
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "completed");
    assert.equal(scene.turns().length, 2);
    assert.deepEqual(scene.turns()[1]?.arguments.slice(-2), [
      "--resume",
      "session-1",
    ]);
  }));

await test("CLV-337 a different process with the recorded process ID is not connected to or signaled", () =>
  withScene(async (scene) => {
    const first = scene.worker("crash-once");
    await first.deliver(intent(), signal);
    await until(() => sessionKnown(scene));
    await first.close({ turns: "keep" });
    await stoppedGroup(scene);
    const other = await priorProcess(scene, { directory: scene.directory });
    try {
      const path = join(folder(scene), "started.json");
      const started: unknown = JSON.parse(readFileSync(path, "utf8"));
      const launch: unknown = field(started, "launch");
      writeFileSync(
        path,
        JSON.stringify({
          ...record(started),
          processId: other.processId,
          launch: { ...record(launch), processId: other.processId },
        }),
      );
      const next = scene.worker("crash-once");
      assert.equal((await next.reconcile(intent(), signal)).kind, "accepted");
      await until(() => scene.reports.length === 1);
      assert.equal(scene.reports[0]?.outcome, "completed");
      assert.equal(scene.turns().length, 2);
      assert.equal(other.terminated(), false);
      assert.equal(alive(other.processId ?? 0), true);
    } finally {
      await other.close();
    }
  }));

const damages = [
  { name: "a work tree", file: "started.json", drop: "worktree" },
  { name: "an attempt start", file: "attempt-1.json", drop: "startedAt" },
  { name: "the harness", file: "started.json", drop: "harness" },
  { name: "the profile", file: "started.json", drop: "" },
] as const;

for (const damage of damages)
  await test(`CLV-337 a running turn with no record of ${damage.name} is interrupted, not connected`, () =>
    withScene(async (scene) => {
      const operation = intent({ method: "run-turn:scoped" });
      const settings = {
        profiles: { scoped: { workflows: ["flow"] } },
        workflowId: () => Promise.resolve("flow"),
      };
      const first = scene.worker("gated-result", settings);
      await first.deliver(operation, signal);
      await until(() => sessionKnown(scene));
      await first.close({ turns: "keep" });
      const path = join(folder(scene), damage.file);
      const fields = { ...record(JSON.parse(readFileSync(path, "utf8"))) };
      Reflect.deleteProperty(fields, damage.drop);
      writeFileSync(path, JSON.stringify(fields));
      const next = scene.worker(
        "gated-result",
        damage.drop === "" ? {} : settings,
      );
      const reply = await next.reconcile(operation, signal);
      assert.deepEqual(
        [reply.kind, field(reply, "reason")],
        ["failed", "claude-turn-interrupted"],
      );
      assert.equal(scene.turns().length, 1);
    }));

await test("CLV-337 a running turn with no start commit is connected with no start commit", () =>
  withScene(async (scene) => {
    const first = scene.worker("gated-result");
    await first.deliver(intent(), signal);
    await until(() => sessionKnown(scene));
    await first.close({ turns: "keep" });
    const path = join(folder(scene), "started.json");
    const fields = { ...record(JSON.parse(readFileSync(path, "utf8"))) };
    writeFileSync(path, JSON.stringify({ ...fields, turnStartCommit: null }));
    const next = scene.worker("gated-result");
    assert.equal((await next.reconcile(intent(), signal)).kind, "accepted");
    opened(scene);
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "completed");
  }));

await test("CLV-337 a background tool process keeps running through the restart, its result reaches the turn, and the end of the turn stops it", () =>
  withScene(async (scene) => {
    const marker = join(scene.directory, "turns.log.background-pid");
    const first = scene.worker("background");
    await first.deliver(intent(), signal);
    await until(() => existsSync(marker) && sessionKnown(scene));
    const background = Number(readFileSync(marker, "utf8"));
    try {
      await first.close({ turns: "keep" });
      await delay(3500);
      assert.equal(alive(background), true);
      const next = scene.worker("background");
      assert.equal((await next.reconcile(intent(), signal)).kind, "accepted");
      assert.equal(alive(background), true);
      opened(scene);
      await until(() => scene.reports.length === 1);
      assert.equal(
        resultOf(scene.reports[0]?.result)["summary"],
        "background done",
      );
      await until(() => !alive(background));
    } finally {
      if (alive(background)) process.kill(background, "SIGKILL");
    }
  }));
