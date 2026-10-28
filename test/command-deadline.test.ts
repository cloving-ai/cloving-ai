import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import {
  startCommand,
  type CommandEnd,
  type CommandStart,
  type RunningCommand,
} from "../src/daemon/command-process.ts";
import {
  commandIntent,
  fakeCommandClock,
  signal,
  withCommandScene,
} from "./command-worker-fixture.ts";
import { until } from "./claude-worker-fixture.ts";
import { located } from "../src/daemon/operation-journal.ts";

const noon = Date.parse("2026-10-28T12:00:00.000Z");

function commandStart(
  directory: string,
  overrides: Partial<CommandStart> = {},
): CommandStart {
  return {
    command: [
      "env",
      "-u",
      "NODE_V8_COVERAGE",
      process.execPath,
      "-e",
      "setInterval(() => {}, 1000)",
    ],
    directory,
    folder: directory,
    payload: "{}",
    runId: "run-1",
    operationId: "operation-1",
    seconds: 60,
    ...overrides,
  };
}

await test("CLV-235 expiry during process preparation prevents spawning", () =>
  withCommandScene(async (scene) => {
    const timing = fakeCommandClock(noon);
    const spawned = childProcess.spawn;
    const observations = [noon, noon + 137];
    let spawns = 0;
    childProcess.spawn = () => {
      spawns += 1;
      throw new Error("expired-command-spawned");
    };
    syncBuiltinESMExports();
    let running: RunningCommand | undefined;
    try {
      running = startCommand(
        commandStart(scene.directory, {
          deadline: new Date(noon + 137).toISOString(),
        }),
        { ...timing.clock, now: () => observations.shift() ?? noon + 137 },
      );
      timing.tick(1);
      const result = await running.ended;
      assert.equal(result.reason, "command-wait-timeout");
      assert.equal(spawns, 0);
      assert.deepEqual(readdirSync(scene.directory), ["command.stderr.log"]);
    } finally {
      running?.stop();
      await running?.ended;
      childProcess.spawn = spawned;
      syncBuiltinESMExports();
    }
  }));

for (const offset of [-1, 0, 1]) {
  await test(`CLV-235 a command settling at deadline offset ${String(offset)} cannot report late success`, () =>
    withCommandScene(async (scene) => {
      const timing = fakeCommandClock(noon);
      const request = commandStart(scene.directory, {
        command: [
          "env",
          "-u",
          "NODE_V8_COVERAGE",
          process.execPath,
          "-e",
          'process.stdout.write("ready")',
        ],
        deadline: new Date(noon + 1000).toISOString(),
      });
      const running = startCommand(request, timing.clock);
      try {
        timing.setTime(noon + 1000 + offset);
        const result = await running.ended;
        assert.equal(
          result.reason,
          offset < 0 ? undefined : "command-wait-timeout",
        );
      } finally {
        running.stop();
        await running.ended;
      }
    }));
}

await test("CLV-235 a command stops at its subsecond wait deadline", () =>
  withCommandScene(async (scene) => {
    const timing = fakeCommandClock(noon);
    const request = commandStart(scene.directory, {
      deadline: new Date(noon + 137).toISOString(),
    });
    const running = startCommand(request, timing.clock);
    const results: CommandEnd[] = [];
    const ended = running.ended.then((end) => {
      results.push(end);
    });
    try {
      timing.tick(136);
      await Promise.resolve();
      assert.equal(results.length, 0);
      timing.tick(1);
      await Promise.resolve();
      await Promise.resolve();
      assert.equal(results[0]?.reason, "command-wait-timeout");
    } finally {
      running.stop();
      await ended;
    }
  }));

await test("CLV-235 a later wait deadline cannot lengthen the execution timeout", () =>
  withCommandScene(async (scene) => {
    const timing = fakeCommandClock(noon);
    const running = startCommand(
      commandStart(scene.directory, {
        seconds: 1,
        deadline: new Date(noon + 2_592_000_000).toISOString(),
      }),
      timing.clock,
    );
    const results: CommandEnd[] = [];
    const ended = running.ended.then((end) => {
      results.push(end);
    });
    try {
      timing.tick(999);
      await Promise.resolve();
      assert.equal(results.length, 0);
      timing.tick(1);
      await ended;
      assert.equal(results[0]?.reason, "command-timeout");
    } finally {
      running.stop();
      await ended;
    }
  }));

await test("CLV-235 concurrent deliveries keep the first deadline and one journal result", () =>
  withCommandScene(async (scene) => {
    const timing = fakeCommandClock(noon);
    const worker = scene.worker("setInterval(() => {}, 1000)", {
      commandClock: timing.clock,
    });
    const intent = {
      ...commandIntent(),
      commandDeadline: new Date(noon + 137).toISOString(),
    };
    const deliveries = await Promise.all([
      worker.deliver(intent, signal),
      ...Array.from({ length: 7 }, () =>
        worker.deliver(
          { ...intent, commandDeadline: new Date(noon + 60_000).toISOString() },
          signal,
        ),
      ),
    ]);
    assert.ok(deliveries.every((delivery) => delivery === deliveries[0]));
    assert.match(scene.recorded("started.json"), /12:00:00.137Z/);
    timing.tick(137);
    await until(() => scene.reports.length === 1);
    const report = scene.reports[0];
    assert.ok(report);
    assert.equal(report.reason, "command-wait-timeout");
    assert.equal(report.outcome, "failed");
    assert.equal(report.result, undefined);
    assert.equal("kind" in (await worker.deliver(intent, signal)), true);
    assert.equal(scene.reports.length, 1);
  }));

await test("CLV-235 expiry while loading command input cannot launch a process", () =>
  withCommandScene(async (scene) => {
    const timing = fakeCommandClock(noon);
    const payload = Promise.withResolvers<string>();
    const worker = scene.worker('process.stdout.write("must not run")', {
      commandClock: timing.clock,
      document: () => payload.promise,
    });
    const opening = worker.deliver(
      {
        ...commandIntent(),
        commandDeadline: new Date(noon + 1000).toISOString(),
      },
      signal,
    );
    timing.setTime(noon + 1000);
    payload.resolve("{}");
    await opening;
    await until(() => scene.reports.length === 1);
    const report = scene.reports[0];
    assert.ok(report);
    assert.equal(report.reason, "command-wait-timeout");
    assert.equal(report.result, undefined);
    assert.deepEqual(
      readdirSync(located(scene.journal, "operation-1").folder).sort(),
      ["result.json", "started.json"],
    );
  }));

await test("CLV-235 a completed journal result replays after its deadline without execution", () =>
  withCommandScene(async (scene) => {
    const timing = fakeCommandClock(noon);
    const worker = scene.worker(
      'require("node:fs").appendFileSync("calls", "one"); process.stdout.write("ready");',
      { commandClock: timing.clock },
    );
    const intent = {
      ...commandIntent(),
      commandDeadline: new Date(noon + 1000).toISOString(),
    };
    await worker.deliver(intent, signal);
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.result, "ready");
    await worker.close();
    timing.setTime(noon + 1000);
    const restarted = scene.worker('throw new Error("must not run")', {
      commands: {},
    });
    const replay = await restarted.deliver(intent, signal);
    assert.equal("kind" in replay && replay.kind, "completed");
    assert.equal("result" in replay && replay.result, "ready");
    assert.equal(readFileSync(join(scene.directory, "calls"), "utf8"), "one");
    assert.equal(scene.reports.length, 1);
  }));

for (const deadline of [
  "not-a-date",
  "",
  "2026-02-30T12:00:00.000Z",
  "2026-10-28T12:00:00+00:00",
]) {
  await test(`CLV-235 invalid command deadline ${JSON.stringify(deadline)} refuses before launch`, () =>
    withCommandScene(async (scene) => {
      const timing = fakeCommandClock(noon);
      const request = commandStart(scene.directory, { deadline });
      const running = startCommand(request, timing.clock);
      const results: CommandEnd[] = [];
      const ended = running.ended.then((end) => {
        results.push(end);
      });
      try {
        await Promise.resolve();
        assert.equal(results[0]?.reason, "invalid-command-deadline");
        assert.deepEqual(readdirSync(scene.directory), []);
      } finally {
        running.stop();
        await ended;
      }
    }));
}

for (const offset of [-1, 0]) {
  await test(`CLV-235 a command does not spawn at deadline offset ${String(offset)}`, () =>
    withCommandScene(async (scene) => {
      const timing = fakeCommandClock(noon);
      const request = commandStart(scene.directory, {
        deadline: new Date(noon + offset).toISOString(),
      });
      const running = startCommand(request, timing.clock);
      try {
        timing.tick(1);
        const result = await running.ended;
        assert.equal(result.reason, "command-wait-timeout");
        assert.deepEqual(readdirSync(scene.directory), []);
        assert.equal(result.exitCode, null);
        assert.equal(result.stdout, "");
        assert.equal(result.durationMilliseconds, 0);
      } finally {
        running.stop();
        await running.ended;
      }
    }));
}

await test("CLV-235 the command worker journals expiry without launching and replays it", () =>
  withCommandScene(async (scene) => {
    const worker = scene.worker('process.stdout.write("must not run");');
    const intent = {
      ...commandIntent(),
      commandDeadline: "2026-01-01T00:00:00.000Z",
    };
    await worker.deliver(intent, signal);
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "failed");
    const report = scene.reports[0];
    assert.ok(report);
    assert.equal(report.reason, "command-wait-timeout");
    assert.equal(report.result, undefined);
    assert.equal(
      readdirSync(located(scene.journal, intent.operationId).folder).includes(
        "command.stderr.log",
      ),
      false,
    );
    await worker.close();
    const restarted = scene.worker('throw new Error("must not run");');
    const replay = await restarted.deliver(intent, signal);
    assert.equal("kind" in replay && replay.kind, "failed");
    assert.equal("reason" in replay && replay.reason, "command-wait-timeout");
    assert.equal(scene.reports.length, 1);
  }));
