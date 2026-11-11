import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { located } from "../src/daemon/operation-journal.ts";
import { processExists } from "../src/daemon/process-identity.ts";
import type { TurnRecovery } from "../src/turn-recovery.ts";
import { until } from "./claude-worker-fixture.ts";
import { commandIntent, withCommandScene } from "./command-worker-fixture.ts";
import { crashedService, markedProcess } from "./crashed-service-fixture.ts";

type Scene = Parameters<Parameters<typeof withCommandScene>[0]>[0];

const waiting =
  'const fs = require("node:fs"); fs.appendFileSync("calls", "one\\n"); fs.writeFileSync("started", String(process.ppid)); const wait = setInterval(() => { if (!fs.existsSync("go")) return; clearInterval(wait); process.stdout.write("done"); }, 20);';

const crashing = `
const [moduleUrl, directory, journal, source, intentText] = process.argv.slice(1);
const { commandWorker } = await import(moduleUrl);
const worker = commandWorker({
  repository: directory,
  journal,
  commands: { scan: ["env", "-u", "NODE_V8_COVERAGE", process.execPath, "-e", source] },
  document: () => Promise.resolve('{"value":"hello"}'),
  report: () => Promise.resolve(),
});
await worker.deliver(JSON.parse(intentText), new AbortController().signal);
setInterval(() => undefined, 1000);
`;

function folder(scene: Scene): string {
  return located(scene.journal, "operation-1").folder;
}

async function crashedCommand(scene: Scene): Promise<number> {
  await crashedService({
    directory: scene.directory,
    source: crashing,
    arguments: [
      new URL("../src/daemon/command-worker.ts", import.meta.url).href,
      scene.directory,
      scene.journal,
      waiting,
      JSON.stringify(commandIntent()),
    ],
    started: () => existsSync(join(scene.directory, "started")),
  });
  assert.equal(existsSync(join(folder(scene), "launch.json")), false);
  return Number(readFileSync(join(scene.directory, "started"), "utf8"));
}

await test("CLV-350 a new worker connects to a command whose service stopped before its launch record, and reports its result one time", () =>
  withCommandScene(async (scene) => {
    const group = await crashedCommand(scene);
    try {
      const recoveries: TurnRecovery[] = [];
      const second = scene.worker('throw new Error("must not run")', {
        recovered: (recovery) => recoveries.push(recovery),
      });
      await second.recover([commandIntent()]);
      assert.deepEqual(recoveries, [{ runId: "run-1", way: "command" }]);
      assert.equal(existsSync(join(folder(scene), "launch.json")), true);
      writeFileSync(join(scene.directory, "go"), "");
      await until(() => scene.reports.length === 1);
      assert.equal(scene.reports[0]?.outcome, "completed");
      assert.equal(scene.reports[0].result, "done");
      assert.equal(
        readFileSync(join(scene.directory, "calls"), "utf8"),
        "one\n",
      );
    } finally {
      if (processExists(group)) process.kill(-group, "SIGKILL");
    }
  }));

function plannedCommand(scene: Scene, marker: string): void {
  const place = folder(scene);
  mkdirSync(place, { recursive: true });
  writeFileSync(
    join(place, "started.json"),
    JSON.stringify({ name: "scan", startedAt: new Date().toISOString() }),
  );
  writeFileSync(
    join(place, "launch-marker.json"),
    JSON.stringify({
      marker,
      output: join(place, "command.stdout"),
      offset: 0,
      exit: join(place, "command.exit.json"),
      configuration: join(place, "gh-config-old"),
    }),
  );
}

await test("CLV-350 a process with the marker that started before the recorded start of the command is not connected to or signaled", () =>
  withCommandScene(async (scene) => {
    const marker = `cloving-turn-${randomUUID()}`;
    const other = markedProcess(scene.directory, marker);
    try {
      await until(other.known);
      await delay(1100);
      plannedCommand(scene, marker);
      const recoveries: TurnRecovery[] = [];
      const second = scene.worker('throw new Error("must not run")', {
        recovered: (recovery) => recoveries.push(recovery),
      });
      await second.recover([commandIntent()]);
      assert.deepEqual(recoveries, []);
      assert.equal(scene.reports[0]?.reason, "command-interrupted");
      await delay(300);
      assert.equal(existsSync(join(scene.directory, "signalled")), false);
      assert.equal(processExists(other.processId), true);
    } finally {
      other.close();
    }
  }));

await test("CLV-350 a new worker stops each process with the marker when more than one matches, and the command is interrupted", () =>
  withCommandScene(async (scene) => {
    const marker = `cloving-turn-${randomUUID()}`;
    plannedCommand(scene, marker);
    const matches = [
      markedProcess(scene.directory, marker),
      markedProcess(scene.directory, marker),
    ];
    try {
      for (const match of matches) await until(match.known);
      const recoveries: TurnRecovery[] = [];
      const second = scene.worker('throw new Error("must not run")', {
        recovered: (recovery) => recoveries.push(recovery),
      });
      await second.recover([commandIntent()]);
      assert.deepEqual(recoveries, []);
      assert.equal(scene.reports[0]?.reason, "command-interrupted");
      await until(() =>
        matches.every((match) => !processExists(match.processId)),
      );
    } finally {
      for (const match of matches) match.close();
    }
  }));

await test("CLV-350 a command with a marker and no matching process is interrupted, as before", () =>
  withCommandScene(async (scene) => {
    const group = await crashedCommand(scene);
    process.kill(-group, "SIGKILL");
    await until(() => !processExists(group));
    assert.equal(existsSync(join(folder(scene), "launch-marker.json")), true);
    const second = scene.worker('throw new Error("must not run")');
    await second.recover([commandIntent()]);
    assert.equal(scene.reports[0]?.outcome, "failed");
    assert.equal(scene.reports[0].reason, "command-interrupted");
    assert.equal(existsSync(join(folder(scene), "launch.json")), false);
  }));

await test("CLV-350 the README states that the service finds a kept turn or command by its marker when the service stopped before the launch record", () => {
  const readme = readFileSync(
    new URL("../README.md", import.meta.url),
    "utf8",
  ).replaceAll("\n", " ");
  assert.match(
    readme,
    /The service writes the marker to `launch-marker\.json` in the journal folder of the turn or the command before it starts the start program\./,
  );
  assert.match(
    readme,
    /It accepts only a process that started after the recorded start of the turn or the command\./,
  );
  assert.match(
    readme,
    /More than one match: the service stops each matched process and records the turn or the command as interrupted\./,
  );
});
