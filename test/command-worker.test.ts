import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { until } from "./claude-worker-fixture.ts";
import { startCommand } from "../src/daemon/command-process.ts";
import {
  commandIntent,
  signal,
  withCommandScene,
} from "./command-worker-fixture.ts";

await test("CLV-201 synthetic commands do not inherit runtime coverage recording", () =>
  withCommandScene(async (scene) => {
    const directory = join(scene.directory, "coverage");
    mkdirSync(directory);
    const previous = process.env["NODE_V8_COVERAGE"];
    process.env["NODE_V8_COVERAGE"] = directory;
    try {
      const worker = scene.worker(
        "process.stdout.write(JSON.stringify(process.env.NODE_V8_COVERAGE ?? null));",
      );
      await worker.deliver(commandIntent(), signal);
      await until(() => scene.reports.length === 1);
      assert.equal(scene.reports[0]?.result, "null");
      assert.deepEqual(readdirSync(directory), []);
    } finally {
      if (previous === undefined) delete process.env["NODE_V8_COVERAGE"];
      else process.env["NODE_V8_COVERAGE"] = previous;
    }
  }));

for (const [source, reason, exitCode] of [
  [
    'process.stderr.write("exit detail"); process.exitCode = 7;',
    "command-exit",
    7,
  ],
  [
    'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);',
    "command-timeout",
    null,
  ],
  ['process.stdout.write("x".repeat(1048577));', "command-output-limit", null],
  ['process.stderr.write("x".repeat(65537));', "command-output-limit", null],
] as const) {
  await test(`CLV-178 local command failure ${reason} for ${source}`, () =>
    withCommandScene(async (scene) => {
      const worker = scene.worker(source, { seconds: 1 });
      await worker.deliver(commandIntent(), signal);
      await until(() => scene.reports.length === 1);
      const report = scene.reports[0];
      assert.ok(report);
      assert.equal(report.outcome, "failed");
      assert.equal(report.reason, reason);
      assert.equal(report.result, undefined);
      const result: unknown = JSON.parse(scene.recorded("result.json"));
      assert.ok(
        exitCode === null ||
          Reflect.get(Object(result), "exitCode") === exitCode,
      );
      assert.ok(
        Buffer.byteLength(scene.recorded("command.stderr.log")) <= 65536,
      );
    }));
}

await test("CLV-178 commands accept exactly the stdout and stderr byte limits", () =>
  withCommandScene(async (scene) => {
    const worker = scene.worker(
      'process.stdout.write("語".repeat(349525) + "x"); process.stderr.write("e".repeat(65536));',
    );
    await worker.deliver(commandIntent(), signal);
    await until(() => scene.reports.length === 1);
    const report = scene.reports[0];
    assert.ok(report);
    assert.equal(report.outcome, "completed");
    assert.equal(Buffer.byteLength(report.result ?? ""), 1048576);
    assert.equal(scene.recorded("command.stderr.log").length, 65536);
  }));

await test("CLV-178 an unavailable executable records command-exit with no exit status and no stderr result", () =>
  withCommandScene(async (scene) => {
    const worker = scene.worker("", {
      commands: { scan: ["/cloving-test-missing-executable"] },
    });
    await worker.deliver(commandIntent(), signal);
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.reason, "command-exit");
    const result: unknown = JSON.parse(scene.recorded("result.json"));
    assert.equal(Reflect.get(Object(result), "exitCode"), -2);
    assert.equal(scene.recorded("command.stderr.log"), "");
  }));

await test("CLV-178 a local command receives JSON stdin in the repository and returns raw stdout with stderr only in its journal", () =>
  withCommandScene(async (scene) => {
    const worker = scene.worker(`
      let input = "";
      for await (const chunk of process.stdin) input += chunk;
      process.stderr.write("private diagnostic\\n");
      process.stdout.write(JSON.stringify({ input, directory: process.cwd(), run: process.env.CLOVING_RUN_ID, operation: process.env.CLOVING_OPERATION_ID }) + "\\n");
    `);
    const accepted = await worker.deliver(commandIntent(), signal);
    assert.equal("receipt" in accepted, true);
    await until(() => scene.reports.length === 1);
    const report = scene.reports[0];
    assert.ok(report);
    assert.equal(report.outcome, "completed");
    assert.equal(
      report.result,
      JSON.stringify({
        input: '{"value":"hello"}',
        directory: scene.directory,
        run: "run-1",
        operation: "operation-1",
      }) + "\n",
    );
    assert.equal(scene.recorded("command.stderr.log"), "private diagnostic\n");
    const result: unknown = JSON.parse(scene.recorded("result.json"));
    assert.equal(Reflect.get(Object(result), "exitCode"), 0);
    assert.equal(
      typeof Reflect.get(Object(result), "durationMilliseconds"),
      "number",
    );
  }));

await test("CLV-178 the command deadline settles even when an escaped descendant keeps stdout and stderr open", () =>
  withCommandScene(async (scene) => {
    const worker = scene.worker(
      'const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: ["ignore", 1, 2] }); require("node:fs").writeFileSync("descendant", String(child.pid)); setInterval(() => {}, 1000);',
      { seconds: 1 },
    );
    await worker.deliver(commandIntent(), signal);
    try {
      await delay(1500);
      assert.equal(scene.reports[0]?.reason, "command-timeout");
    } finally {
      const file = join(scene.directory, "descendant");
      if (existsSync(file))
        process.kill(Number(readFileSync(file, "utf8")), "SIGKILL");
    }
  }));

async function withSignalFailure(
  code: string,
  use: () => Promise<void>,
): Promise<void> {
  const descriptor = Object.getOwnPropertyDescriptor(process, "kill");
  assert.ok(descriptor);
  process.kill = () => {
    throw Object.assign(new Error("group signal failed"), { code });
  };
  try {
    await use();
  } finally {
    Object.defineProperty(process, "kill", descriptor);
  }
}

for (const code of ["ESRCH", "EPERM"]) {
  await test(`CLV-178 stopping a command handles process group signal failure ${code}`, () =>
    withCommandScene(async (scene) => {
      const worker = scene.worker("setInterval(() => {}, 1000);");
      await worker.deliver(commandIntent(), signal);
      await withSignalFailure(code, async () => {
        assert.equal(
          (await worker.stop(commandIntent(), signal)).kind,
          "stopped",
        );
      });
    }));
}

await test("CLV-178 unexpected process group signal errors propagate to the stop caller", () =>
  withCommandScene(async (scene) => {
    const worker = scene.worker("setInterval(() => {}, 1000);");
    await worker.deliver(commandIntent(), signal);
    await withSignalFailure("EINVAL", async () => {
      await assert.rejects(worker.stop(commandIntent(), signal), {
        code: "EINVAL",
      });
    });
  }));

await test("CLV-178 stopping a failed spawn does not signal an unrelated process", () =>
  withCommandScene(async (scene) => {
    const running = startCommand({
      command: ["/cloving-test-missing-executable"],
      directory: scene.directory,
      folder: scene.directory,
      payload: "{}",
      runId: "run-1",
      operationId: "operation-1",
      seconds: 60,
    });
    running.stop();
    assert.equal((await running.ended).reason, "command-exit");
  }));

await test("CLV-178 a command that exits before reading stdin still returns its stdout", () =>
  withCommandScene(async (scene) => {
    const worker = scene.worker(
      'process.stdout.write("early"); process.exit(0);',
      {
        document: () => Promise.resolve(JSON.stringify("x".repeat(1048576))),
      },
    );
    await worker.deliver(commandIntent(), signal);
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "completed");
    assert.equal(scene.reports[0].result, "early");
  }));
