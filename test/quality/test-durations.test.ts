import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { once } from "node:events";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { runSupervisedCommand } from "../../quality/command.ts";
import { testCommand } from "../../quality/test-execution.ts";
import { testMilliseconds } from "../test-timing.ts";
import { withFiles } from "./files-fixture.ts";

await test("CLV-174 starts unknown files first, then longest files with path ties", () => {
  const tests = ["fast", "new-b", "slow-b", "new-a", "slow-a"]
    .map((name) => resolve("test", `${name}.test.ts`))
    .sort();
  const durations = {
    "test/fast.test.ts": 0,
    "test/slow-b.test.ts": 10,
    "test/slow-a.test.ts": 10,
    "test/deleted.test.ts": 100,
  };
  const expected = ["new-a", "new-b", "slow-a", "slow-b", "fast"].map((name) =>
    resolve("test", `${name}.test.ts`),
  );
  const original = [...tests];
  for (const files of [tests, [...tests].reverse(), tests])
    assert.deepEqual(
      testCommand(process.cwd(), { tests: files, durations }).arguments.slice(
        -tests.length,
      ),
      expected,
    );
  assert.deepEqual(tests, original);
});

await test("CLV-174 keeps report files sorted when slow files start first", async () => {
  const source =
    'import { test } from "node:test"; await test("passes", () => {});';
  await withFiles(
    { "a.test.ts": source, "z.test.ts": source },
    async (directory) => {
      const tests = [
        join(directory, "a.test.ts"),
        join(directory, "z.test.ts"),
      ];
      const command = testCommand(directory, {
        tests,
        durations: { "a.test.ts": 1, "z.test.ts": 20 },
      });
      assert.deepEqual(command.arguments.slice(-2), [...tests].reverse());
      const report: unknown = JSON.parse(await runSupervisedCommand(command));
      assert.ok(report !== null && typeof report === "object");
      assert.deepEqual(Reflect.get(report, "files"), tests);
      assert.equal(Reflect.get(report, "completed"), 2);
      assert.deepEqual(Reflect.get(report, "failures"), []);
    },
  );
});

await test("CLV-174 actually starts the slow file first with one worker", async () => {
  const source =
    'import { appendFileSync } from "node:fs"; import { basename } from "node:path"; import { test } from "node:test"; appendFileSync("starts", basename(import.meta.filename) + "\\n"); await test("passes", () => {});';
  await withFiles(
    { "a.test.ts": source, "z.test.ts": source },
    async (directory) => {
      const command = testCommand(directory, {
        tests: [join(directory, "a.test.ts"), join(directory, "z.test.ts")],
        durations: { "a.test.ts": 1, "z.test.ts": 20 },
      });
      await runSupervisedCommand({
        ...command,
        arguments: command.arguments.map((argument) =>
          argument.startsWith("--test-concurrency=")
            ? "--test-concurrency=1"
            : argument,
        ),
      });
      assert.equal(
        readFileSync(join(directory, "starts"), "utf8"),
        "z.test.ts\na.test.ts\n",
      );
    },
  );
});

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = performance.now() + testMilliseconds(5000);
  while (!condition() && performance.now() < deadline) await setTimeout(20);
  assert.ok(condition(), "test process did not reach the expected state");
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (Reflect.get(Object(error), "code") !== "ESRCH") throw error;
    return false;
  }
}

function stopGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (Reflect.get(Object(error), "code") !== "ESRCH") throw error;
  }
}

const interruptionFiles = {
  "main.test.ts":
    'import { writeFileSync } from "node:fs"; import { test } from "node:test"; const timer = setInterval(() => {}, 1000); process.on("SIGTERM", () => { clearInterval(timer); }); writeFileSync("pid", String(process.pid)); writeFileSync("ready", ""); await test("passes", () => {});',
  "z.test.ts":
    'import { writeFileSync } from "node:fs"; writeFileSync("queued", "");',
};

for (const signal of ["SIGINT", "SIGTERM"] as const)
  await test(`CLV-174 ${signal} stops the launcher's test children`, async () => {
    await withFiles(interruptionFiles, async (directory) => {
      const command = testCommand(directory, {
        tests: [join(directory, "main.test.ts"), join(directory, "z.test.ts")],
      });
      const argumentsList = command.arguments.map((argument) =>
        argument.startsWith("--test-concurrency=")
          ? "--test-concurrency=1"
          : argument,
      );
      const launcher = spawn(command.executable, argumentsList, {
        cwd: directory,
        env: { PATH: process.env["PATH"] },
        stdio: "ignore",
        detached: true,
      });
      const closed = once(launcher, "close");
      let pid: number | undefined;
      try {
        await waitFor(() => existsSync(join(directory, "ready")));
        const identity = Number(readFileSync(join(directory, "pid"), "utf8"));
        assert.ok(Number.isSafeInteger(identity) && identity > 0);
        pid = identity;
        assert.ok(running(pid));
        assert.equal(launcher.kill(signal), true);
        await waitFor(
          () => launcher.exitCode !== null || launcher.signalCode !== null,
        );
        const result = await closed;
        assert.notEqual(result[0], 0);
        const child = pid;
        await waitFor(() => !running(child));
        assert.equal(existsSync(join(directory, "queued")), false);
      } finally {
        stopGroup(launcher.pid);
        await closed;
      }
    });
  });

function timeoutSupervisor(): string {
  const commandModule = pathToFileURL(resolve("quality/command.ts")).href;
  const executionModule = pathToFileURL(
    resolve("quality/test-execution.ts"),
  ).href;
  return `import { runSupervisedCommand } from ${JSON.stringify(commandModule)}; import { testCommand } from ${JSON.stringify(executionModule)}; import { writeFileSync } from "node:fs"; try { await runSupervisedCommand({ ...testCommand(process.cwd(), { tests: ["main.test.ts"] }), timeoutMilliseconds: ${String(testMilliseconds(1500))} }); } catch (error) { writeFileSync("timed-out", String(error)); }`;
}

for (const signal of ["SIGINT", "SIGTERM"] as const)
  await test(`CLV-174 stopping the gate with ${signal} stops resistant workers`, async () => {
    const module = pathToFileURL(resolve("quality/test-execution.ts")).href;
    await withFiles(
      {
        "supervisor.ts": `import { checkTests } from ${JSON.stringify(module)}; await checkTests(process.cwd(), { files: ["main.test.ts"] });`,
        "main.test.ts":
          'import { writeFileSync } from "node:fs"; import { test } from "node:test"; process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); writeFileSync("identity", JSON.stringify({ child: process.pid, launcher: process.ppid })); writeFileSync("ready", ""); await test("passes", () => {});',
      },
      async (directory) => {
        const gate = spawn(process.execPath, ["supervisor.ts"], {
          cwd: directory,
          env: { PATH: process.env["PATH"] },
          stdio: "ignore",
          detached: true,
        });
        const closed = once(gate, "close");
        let launcher: number | undefined;
        try {
          await waitFor(() => existsSync(join(directory, "ready")));
          const identity: unknown = JSON.parse(
            readFileSync(join(directory, "identity"), "utf8"),
          );
          assert.ok(identity !== null && typeof identity === "object");
          const parent: unknown = Reflect.get(identity, "launcher");
          const child: unknown = Reflect.get(identity, "child");
          assert.ok(typeof parent === "number" && parent > 0);
          assert.ok(typeof child === "number" && child > 0);
          launcher = parent;
          assert.ok(gate.pid);
          process.kill(-gate.pid, signal);
          await waitFor(() => !running(child) && !running(parent));
          await waitFor(
            () => gate.exitCode !== null || gate.signalCode !== null,
          );
          assert.notEqual((await closed)[0], 0);
        } finally {
          stopGroup(launcher);
          stopGroup(gate.pid);
          await closed;
        }
      },
    );
  });

await test("CLV-174 the gate timeout stops signal-resistant test process groups", async () => {
  const source =
    'import { writeFileSync } from "node:fs"; import { test } from "node:test"; process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); writeFileSync("identity", JSON.stringify({ child: process.pid, launcher: process.ppid })); await test("passes", () => {});';
  await withFiles(
    { "main.test.ts": source, "supervisor.ts": timeoutSupervisor() },
    async (directory) => {
      const supervising = spawn(process.execPath, ["supervisor.ts"], {
        cwd: directory,
        env: { PATH: process.env["PATH"] },
        stdio: "ignore",
        detached: true,
      });
      const closed = once(supervising, "close");
      let launcher: number | undefined;
      try {
        await waitFor(() => existsSync(join(directory, "timed-out")));
        assert.deepEqual(await closed, [0, null]);
        const identity: unknown = JSON.parse(
          readFileSync(join(directory, "identity"), "utf8"),
        );
        assert.ok(identity !== null && typeof identity === "object");
        const parent: unknown = Reflect.get(identity, "launcher");
        const child: unknown = Reflect.get(identity, "child");
        assert.ok(
          typeof parent === "number" &&
            Number.isSafeInteger(parent) &&
            parent > 0,
        );
        launcher = parent;
        assert.ok(
          typeof child === "number" && Number.isSafeInteger(child) && child > 0,
        );
        assert.match(
          readFileSync(join(directory, "timed-out"), "utf8"),
          /Check execution failed: tests/,
        );
        await waitFor(() => !running(child));
      } finally {
        stopGroup(launcher);
        stopGroup(supervising.pid);
        await closed;
      }
    },
  );
});
