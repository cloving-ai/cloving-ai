import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { record as fields } from "../src/protocol.ts";
import type { TurnRecovery } from "../src/turn-recovery.ts";
import {
  alive,
  field,
  intent,
  record,
  resultOf,
  until,
  withScene,
  type Scene,
  type WorkerOverrides,
} from "./claude-worker-fixture.ts";
import {
  gatedHarness,
  harnessOutputs,
  harnessProcesses,
  openGate,
  operationFile,
  transcriptLines,
} from "./harness-detached-fixture.ts";
import {
  crashedService,
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
  turnSettings: () => ({ profiles: settings.profiles ?? {}, fallbackModels: [], tokenPrices: {} }),
});
await worker.deliver(intent, new AbortController().signal);
setInterval(() => undefined, 1000);
`;

async function completedMarker(
  scene: Scene,
  options: { readonly worker: string; readonly settings?: WorkerOverrides },
) {
  const { worker, settings = {} } = options;
  const harness = gatedHarness(scene, {
    worker,
    name: worker,
    output: harnessOutputs[worker] ?? { head: [], tail: [] },
  });
  await crashedService({
    directory: scene.directory,
    source: crashing,
    arguments: [
      new URL("../src/daemon/claude-worker.ts", import.meta.url).href,
      JSON.stringify({
        ...harness.settings,
        ...settings,
        repository: scene.repository,
        worktrees: scene.worktrees,
        journal: scene.journal,
        intent: intent(),
      }),
    ],
    started: () => harnessProcesses(harness).length === 1,
  });
  const [turn] = harnessProcesses(harness);
  assert.ok(turn);
  const started = record(scene, "operation-1/started.json");
  assert.equal(field(started, "phase"), "starting");
  assert.equal(field(started, "launch"), undefined);
  openGate(harness);
  await until(() => !alive(turn.processId) && !alive(turn.parentId));
  const exit = record(scene, "operation-1/turn.exit.json");
  assert.equal(field(exit, "exitCode"), 0);
  assert.equal(record(scene, "operation-1/result.json"), undefined);
  return harness;
}

await test("CLV-349 a completed marker survives a slow Node preload before the launcher starts", () =>
  withScene(async (scene) => {
    const path = join(scene.directory, "preload.mjs");
    writeFileSync(
      path,
      "await new Promise(resolve => setTimeout(resolve, 1500));",
    );
    const previous = process.env["NODE_OPTIONS"];
    process.env["NODE_OPTIONS"] = `--import=${pathToFileURL(path).href}`;
    try {
      const harness = await completedMarker(scene, {
        worker: "gemini",
        settings: { turnVariables: ["NODE_OPTIONS"] },
      });
      const exit = record(scene, "operation-1/turn.exit.json");
      assert.ok(
        Number(field(exit, "startedAt")) -
          Date.parse(String(field(exit, "processStart"))) >
          1000,
      );
      const next = scene.worker("unused", harness.settings);
      assert.equal((await next.reconcile(intent(), signal)).kind, "accepted");
      await until(() => scene.reports.length === 1);
      assert.equal(scene.reports.at(0)?.outcome, "completed");
      assert.equal(harnessProcesses(harness).length, 1);
    } finally {
      if (previous === undefined) delete process.env["NODE_OPTIONS"];
      else process.env["NODE_OPTIONS"] = previous;
    }
  }));

await test("CLV-349 a completed marker retains its result under a localized process locale", () =>
  withScene(async (scene) => {
    const previous = process.env["LC_ALL"];
    process.env["LC_ALL"] = "ru_RU.UTF-8";
    try {
      const harness = await completedMarker(scene, { worker: "gemini" });
      const next = scene.worker("unused", harness.settings);
      assert.equal((await next.reconcile(intent(), signal)).kind, "accepted");
      await until(() => scene.reports.length === 1);
      assert.equal(scene.reports.at(0)?.outcome, "completed");
      assert.equal(harnessProcesses(harness).length, 1);
    } finally {
      if (previous === undefined) delete process.env["LC_ALL"];
      else process.env["LC_ALL"] = previous;
    }
  }));

for (const worker of ["gemini", "pi", "cursor-agent", "opencode", "grok"])
  await test(`CLV-349 a completed ${worker} marker launch recovers its saved result once without a new invocation`, () =>
    withScene(async (scene) => {
      const harness = await completedMarker(scene, { worker });
      const noted: TurnRecovery[] = [];
      const next = scene.worker("unused", {
        ...harness.settings,
        recovered: (recovery) => noted.push(recovery),
      });
      await next.recover(intent());
      await until(() => scene.reports.length === 1);
      assert.deepEqual(noted, [{ runId: "run-1", way: "connected" }]);
      assert.equal(scene.reports.at(0)?.outcome, "completed");
      const result = resultOf(scene.reports[0]?.result);
      assert.match(String(result["summary"]), /Ticket status: complete/);
      assert.equal(
        typeof (result["costUsd"] ?? result["estimatedCostUsd"]),
        "number",
      );
      const transcript = transcriptLines(scene, "operation-1");
      assert.ok(transcript.length > 0);
      assert.equal((await next.reconcile(intent(), signal)).kind, "completed");
      const third = scene.worker("unused", harness.settings);
      assert.equal((await third.reconcile(intent(), signal)).kind, "completed");
      assert.deepEqual(transcriptLines(scene, "operation-1"), transcript);
      assert.equal(scene.reports.length, 1);
      assert.equal(harnessProcesses(harness).length, 1);
    }));

const rejected = [
  { name: "a foreign marker", change: { marker: "cloving-turn-foreign" } },
  { name: "no process ID", change: { processId: null } },
  { name: "no process start", change: { processStart: null } },
  { name: "an invalid process start", change: { processStart: "foreign" } },
  { name: "a stale start", change: { startedAt: 0 } },
  { name: "no end time", change: { endedAt: null } },
  { name: "no exit status", change: { exitCode: "0" } },
];

for (const scenario of rejected)
  await test(`CLV-349 a completed marker with ${scenario.name} cannot supply a result`, () =>
    withScene(async (scene) => {
      const harness = await completedMarker(scene, { worker: "gemini" });
      const path = operationFile(scene, {
        operationId: "operation-1",
        name: "turn.exit.json",
      });
      const saved: unknown = JSON.parse(readFileSync(path, "utf8"));
      writeFileSync(
        path,
        JSON.stringify({ ...fields(saved), ...scenario.change }),
      );
      const transcript = transcriptLines(scene, "operation-1");
      const next = scene.worker("unused", harness.settings);
      assert.equal((await next.reconcile(intent(), signal)).kind, "failed");
      assert.equal(harnessProcesses(harness).length, 1);
      assert.deepEqual(transcriptLines(scene, "operation-1"), transcript);
    }));

await test("CLV-349 a completed marker remains uncertain when its process search fails", () =>
  withScene(async (scene) => {
    const harness = await completedMarker(scene, { worker: "gemini" });
    const next = scene.worker("unused", harness.settings);
    const reply = await withFailedSearches(scene.directory, () =>
      next.reconcile(intent(), signal),
    );
    assert.equal(reply.kind, "unknown");
    assert.equal(record(scene, "operation-1/result.json"), undefined);
    assert.equal(harnessProcesses(harness).length, 1);
    await next.recover(intent());
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports.at(0)?.outcome, "completed");
    assert.equal(harnessProcesses(harness).length, 1);
  }));

await test("CLV-349 a completed marker cannot attach to a live process ID from its exit record", () =>
  withScene(async (scene) => {
    const harness = await completedMarker(scene, { worker: "gemini" });
    const path = operationFile(scene, {
      operationId: "operation-1",
      name: "turn.exit.json",
    });
    const saved: unknown = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(
      path,
      JSON.stringify({ ...fields(saved), processId: process.pid }),
    );
    const next = scene.worker("unused", harness.settings);
    assert.equal((await next.reconcile(intent(), signal)).kind, "unknown");
    assert.equal(record(scene, "operation-1/result.json"), undefined);
    assert.equal(harnessProcesses(harness).length, 1);
  }));

await test("CLV-349 a completed marker uses its saved failing exit code despite successful harness output", () =>
  withScene(async (scene) => {
    const harness = await completedMarker(scene, { worker: "gemini" });
    const path = operationFile(scene, {
      operationId: "operation-1",
      name: "turn.exit.json",
    });
    const saved: unknown = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...fields(saved), exitCode: 7 }));
    const noted: TurnRecovery[] = [];
    const next = scene.worker("unused", {
      ...harness.settings,
      recovered: (recovery) => noted.push(recovery),
    });
    await next.recover(intent());
    await until(() => scene.reports.length === 1);
    assert.deepEqual(noted, [{ runId: "run-1", way: "connected" }]);
    assert.equal(scene.reports[0]?.outcome, "failed");
    assert.equal((await next.reconcile(intent(), signal)).kind, "failed");
    assert.equal(harnessProcesses(harness).length, 1);
  }));
