import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { DeliveryIntent } from "../src/broker/actor/delivery-intents.ts";
import type { CommandWorkerSettings } from "../src/daemon/command-worker.ts";
import { located } from "../src/daemon/operation-journal.ts";
import {
  processExists,
  processIdentity,
} from "../src/daemon/process-identity.ts";
import { recordedLaunch, type TurnLaunch } from "../src/turn-launch.ts";
import type { TurnRecovery } from "../src/turn-recovery.ts";
import { until } from "./claude-worker-fixture.ts";
import {
  commandIntent,
  signal,
  withCommandScene,
} from "./command-worker-fixture.ts";

type Scene = Parameters<Parameters<typeof withCommandScene>[0]>[0];

const waiting =
  'const fs = require("node:fs"); process.stdout.write("first "); fs.writeFileSync("started", ""); const wait = setInterval(() => { if (!fs.existsSync("go")) return; clearInterval(wait); process.stdout.write("done"); }, 20);';

const flooding =
  'const fs = require("node:fs"); fs.writeFileSync("started", ""); const wait = setInterval(() => { if (!fs.existsSync("go")) return; clearInterval(wait); process.stdout.write("x".repeat(2_000_000)); setInterval(() => {}, 1000); }, 20);';

const operation = located("", "operation-1").key;

function launchOf(scene: Scene): TurnLaunch {
  const launch = recordedLaunch(JSON.parse(scene.recorded("launch.json")));
  assert.ok(launch);
  return launch;
}

async function keptCommand(
  scene: Scene,
  options: {
    readonly settings?: Partial<CommandWorkerSettings>;
    readonly source?: string;
    readonly intent?: DeliveryIntent;
  } = {},
): Promise<TurnLaunch> {
  const first = scene.worker(options.source ?? waiting, options.settings);
  await first.deliver(options.intent ?? commandIntent(), signal);
  await until(() => existsSync(join(scene.directory, "started")));
  await first.close({ turns: "keep" });
  return launchOf(scene);
}

function resultFile(scene: Scene): string {
  return join(located(scene.journal, "operation-1").folder, "result.json");
}

await test("CLV-337 a command keeps running through a close that keeps work, and a new worker connects to it and reports its result one time", () =>
  withCommandScene(async (scene) => {
    const launch = await keptCommand(scene);
    assert.equal(processExists(launch.processId), true);
    assert.equal(scene.reports.length, 0);
    assert.equal(existsSync(resultFile(scene)), false);
    const recoveries: TurnRecovery[] = [];
    const second = scene.worker('throw new Error("must not run")', {
      recovered: (recovery) => recoveries.push(recovery),
    });
    await second.recover([commandIntent()]);
    assert.deepEqual(recoveries, [{ runId: "run-1", way: "command" }]);
    assert.deepEqual(await second.reconcile(commandIntent(), signal), {
      kind: "accepted",
      receipt: operation,
      worker: "command",
    });
    writeFileSync(join(scene.directory, "go"), "");
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "completed");
    assert.equal(scene.reports[0].result, "first done");
    await until(() => !processExists(launch.processId));
    await delay(300);
    assert.equal(scene.reports.length, 1);
  }));

await test("CLV-337 a command that ends while no worker runs ends with its result when a new worker starts", () =>
  withCommandScene(async (scene) => {
    const launch = await keptCommand(scene);
    writeFileSync(join(scene.directory, "go"), "");
    await until(() => !processExists(launch.processId));
    const second = scene.worker('throw new Error("must not run")');
    await second.recover([commandIntent()]);
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "completed");
    assert.equal(scene.reports[0].result, "first done");
  }));

await test("CLV-337 a command whose process is gone with no exit file is interrupted when a new worker starts", () =>
  withCommandScene(async (scene) => {
    const launch = await keptCommand(scene);
    process.kill(-launch.processId, "SIGKILL");
    await until(() => !processExists(launch.processId));
    const second = scene.worker('throw new Error("must not run")');
    await second.recover([commandIntent()]);
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "failed");
    assert.equal(scene.reports[0].reason, "command-interrupted");
  }));

await test("CLV-337 the time limit of a kept command counts from its start, not from the new connection", () =>
  withCommandScene(async (scene) => {
    const launch = await keptCommand(scene, { settings: { seconds: 1 } });
    await delay(1100);
    const second = scene.worker('throw new Error("must not run")', {
      seconds: 1,
    });
    await second.recover([commandIntent()]);
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "failed");
    assert.equal(scene.reports[0].reason, "command-timeout");
    await until(() => !processExists(launch.processId));
  }));

await test("CLV-337 a new worker does not connect to or signal a different process with the recorded process ID", () =>
  withCommandScene(async (scene) => {
    const other = spawn(
      process.execPath,
      [
        "-e",
        'process.on("SIGTERM", () => require("node:fs").writeFileSync(process.argv[1], "")); setInterval(() => {}, 1000);',
        join(scene.directory, "signalled"),
      ],
      { detached: true, stdio: "ignore" },
    );
    try {
      const processId = other.pid ?? 0;
      const identity = await processIdentity(processId);
      assert.ok(identity);
      const folder = located(scene.journal, "operation-1").folder;
      mkdirSync(folder, { recursive: true });
      writeFileSync(
        join(folder, "started.json"),
        JSON.stringify({ name: "scan", startedAt: new Date().toISOString() }),
      );
      writeFileSync(
        join(folder, "launch.json"),
        JSON.stringify({
          processId,
          processStart: identity.start,
          marker: "cloving-turn-gone",
          output: join(folder, "command.stdout"),
          offset: 0,
          exit: join(folder, "command.exit.json"),
          configuration: join(folder, "gh-config-gone"),
        }),
      );
      const second = scene.worker('throw new Error("must not run")');
      await second.recover([commandIntent()]);
      await until(() => scene.reports.length === 1);
      assert.equal(scene.reports[0]?.reason, "command-interrupted");
      await second.stop(commandIntent(), signal);
      await delay(300);
      assert.equal(existsSync(join(scene.directory, "signalled")), false);
      assert.equal(processExists(processId), true);
    } finally {
      other.kill("SIGKILL");
    }
  }));

await test("CLV-337 a command whose start is in progress at a close that keeps work starts and keeps running", () =>
  withCommandScene(async (scene) => {
    const payload = Promise.withResolvers<string>();
    const first = scene.worker(waiting, { document: () => payload.promise });
    const delivery = first.deliver(commandIntent(), signal);
    await delay(50);
    const closing = first.close({ turns: "keep" });
    payload.resolve("{}");
    assert.equal("receipt" in (await delivery), true);
    await closing;
    await until(() => existsSync(join(scene.directory, "started")));
    const launch = launchOf(scene);
    assert.equal(processExists(launch.processId), true);
    const second = scene.worker('throw new Error("must not run")');
    await second.recover([commandIntent()]);
    writeFileSync(join(scene.directory, "go"), "");
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "completed");
    assert.equal(scene.reports[0].result, "first done");
  }));

await test("CLV-337 a close that keeps work stops a command whose process identity cannot be read", () =>
  withCommandScene(async (scene) => {
    const tools = join(scene.directory, "tools");
    mkdirSync(tools);
    writeFileSync(join(tools, "ps"), "#!/bin/sh\nexit 2\n", { mode: 0o700 });
    const path = process.env["PATH"] ?? "";
    process.env["PATH"] = `${tools}:${path}`;
    try {
      const first = scene.worker(waiting);
      await first.deliver(commandIntent(), signal);
      await until(() => existsSync(join(scene.directory, "started")));
      await first.close({ turns: "keep" });
    } finally {
      process.env["PATH"] = path;
    }
    assert.equal(scene.reports[0]?.outcome, "stopped");
    const folder = located(scene.journal, "operation-1").folder;
    assert.equal(existsSync(join(folder, "launch.json")), false);
  }));

function exitRecord(scene: Scene): unknown {
  return JSON.parse(scene.recorded("command.exit.json"));
}

await test("CLV-337 a kept command stops at its time limit while no worker runs", () =>
  withCommandScene(async (scene) => {
    const launch = await keptCommand(scene, { settings: { seconds: 1 } });
    await until(() => !processExists(launch.processId));
    assert.equal(
      Reflect.get(Object(exitRecord(scene)), "reason"),
      "command-timeout",
    );
    const second = scene.worker('throw new Error("must not run")');
    await second.recover([commandIntent()]);
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.reason, "command-timeout");
  }));

await test("CLV-337 a kept command stops at its time limit also when its exit record cannot be written", () =>
  withCommandScene(async (scene) => {
    const holding =
      'require("node:fs").writeFileSync("started", String(process.pid)); setInterval(() => {}, 1000);';
    await keptCommand(scene, { source: holding, settings: { seconds: 3 } });
    const folder = located(scene.journal, "operation-1").folder;
    mkdirSync(join(folder, "command.exit.json.tmp"));
    const command = Number(
      readFileSync(join(scene.directory, "started"), "utf8"),
    );
    try {
      await until(() => !processExists(command));
    } finally {
      if (processExists(command)) process.kill(command, "SIGKILL");
    }
  }));

await test("CLV-337 a kept command stops at its output limit while no worker runs", () =>
  withCommandScene(async (scene) => {
    const launch = await keptCommand(scene, { source: flooding });
    writeFileSync(join(scene.directory, "go"), "");
    await until(() => !processExists(launch.processId));
    assert.equal(
      Reflect.get(Object(exitRecord(scene)), "reason"),
      "command-output-limit",
    );
    const second = scene.worker('throw new Error("must not run")');
    await second.recover([commandIntent()]);
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.reason, "command-output-limit");
  }));

await test("CLV-337 a kept command that ended before its limits completes when a new worker starts after them", () =>
  withCommandScene(async (scene) => {
    const deadline = Date.now() + 2000;
    const launch = await keptCommand(scene, {
      settings: { seconds: 2 },
      intent: commandIntent({
        commandDeadline: new Date(deadline).toISOString(),
      }),
    });
    writeFileSync(join(scene.directory, "go"), "");
    await until(() => !processExists(launch.processId));
    await delay(Math.max(0, deadline - Date.now()) + 100);
    const second = scene.worker('throw new Error("must not run")', {
      seconds: 2,
    });
    await second.recover([commandIntent()]);
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "completed");
    assert.equal(scene.reports[0].result, "first done");
  }));

await test("CLV-337 a stop of a connected command waits until its process is gone when its identity cannot be read", () =>
  withCommandScene(async (scene) => {
    const launch = await keptCommand(scene);
    const second = scene.worker('throw new Error("must not run")');
    await second.recover([commandIntent()]);
    const tools = join(scene.directory, "tools");
    mkdirSync(tools);
    writeFileSync(join(tools, "ps"), "#!/bin/sh\nexit 2\n", { mode: 0o700 });
    const path = process.env["PATH"] ?? "";
    process.env["PATH"] = `${tools}:${path}`;
    const stops: string[] = [];
    let stopping: ReturnType<typeof second.stop> | undefined;
    try {
      stopping = second.stop(commandIntent(), signal);
      stopping.then(
        (result) => stops.push(result.kind),
        () => undefined,
      );
      await delay(600);
      assert.deepEqual(stops, []);
      assert.equal(processExists(launch.processId), true);
      assert.equal(existsSync(resultFile(scene)), false);
    } finally {
      process.env["PATH"] = path;
    }
    assert.equal((await stopping).kind, "stopped");
    assert.equal(processExists(launch.processId), false);
  }));
