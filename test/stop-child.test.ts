import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { withFiles } from "./quality/files-fixture.ts";
import { stopChild, stopChildGroup } from "./stop-child.ts";
import { ended as endedDaemon } from "./self-host-fixture.ts";
import { killVerificationGroup } from "../quality/verification-process-group.ts";

await test("CLV-219 the legacy workflow fixture observes a daemon that already closed", async () => {
  for (const signal of [undefined, "SIGTERM"] as const) {
    const child = spawn(
      process.execPath,
      [
        "-e",
        signal === undefined
          ? "process.exit(7)"
          : "setInterval(() => {}, 1000)",
      ],
      { stdio: "ignore" },
    );
    const closed = once(child, "close");
    if (signal !== undefined) child.kill(signal);
    await closed;
    assert.equal(
      await Promise.race([endedDaemon(child), delay(100, "waiting")]),
      signal === undefined ? 7 : null,
    );
  }
});

for (const stop of [stopChild, stopChildGroup])
  await test(`CLV-145 ${stop.name} waits for a covered child exit and leaves complete coverage`, async () => {
    await withFiles({}, async (directory) => {
      const child = spawn(
        process.execPath,
        [
          "-e",
          'process.on("SIGTERM", () => { setTimeout(() => process.exit(0), 50); }); setInterval(() => {}, 1000); console.log("ready");',
        ],
        {
          detached: true,
          env: { ...process.env, NODE_V8_COVERAGE: directory },
          stdio: ["ignore", "pipe", "inherit"],
        },
      );
      const exited = once(child, "exit");
      try {
        await once(child.stdout, "data");
        await stop(child);
        assert.equal(child.exitCode, 0);
        assert.deepEqual(await exited, [0, null]);
        assert.ok((await readdir(directory)).length > 0);
        for (const file of await readdir(directory)) {
          assert.ok(file.startsWith(`coverage-${String(child.pid)}-`));
          const value: unknown = JSON.parse(
            await readFile(join(directory, file), "utf8"),
          );
          assert.ok(value && typeof value === "object" && "result" in value);
        }
      } finally {
        await stop(child);
      }
    });
  });

for (const stop of [stopChild, stopChildGroup])
  await test(`CLV-257 ${stop.name} preserves a covered child's shutdown after its first signal`, async () => {
    await withFiles({}, async (directory) => {
      const child = spawn(
        process.execPath,
        [
          "-e",
          'process.once("message", () => process.disconnect()); process.once("SIGTERM", () => process.send("stopping")); process.send("ready");',
        ],
        {
          detached: true,
          env: { ...process.env, NODE_V8_COVERAGE: directory },
          stdio: ["ignore", "ignore", "inherit", "ipc"],
        },
      );
      const exited = once(child, "exit");
      const kill = child.kill.bind(child);
      let stopping: Promise<void> | undefined;
      try {
        assert.deepEqual(await once(child, "message"), ["ready", undefined]);
        const acknowledged = once(child, "message");
        assert.equal(child.kill("SIGTERM"), true);
        assert.deepEqual(await acknowledged, ["stopping", undefined]);
        const signals: Array<NodeJS.Signals | number | undefined> = [];
        child.kill = (signal) => {
          signals.push(signal);
          return kill(signal);
        };
        stopping = stop(child);
        assert.deepEqual(signals, [], "await shutdown without a second signal");
        child.send("release");
        await stopping;
        assert.deepEqual(await exited, [0, null]);
        const recordings = await readdir(directory);
        assert.ok(recordings.length > 0);
        for (const file of recordings) {
          const value: unknown = JSON.parse(
            await readFile(join(directory, file), "utf8"),
          );
          assert.ok(value && typeof value === "object" && "result" in value);
        }
      } finally {
        child.kill = kill;
        if (child.connected) child.disconnect();
        await stopChild(child);
        await stopping;
        await exited;
      }
    });
  });

await test("CLV-145 stopping a child that ignores SIGTERM escalates after a bounded grace period", async () => {
  const child = spawn(
    process.execPath,
    [
      "-e",
      'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); console.log("ready");',
    ],
    {
      env: { ...process.env, NODE_V8_COVERAGE: undefined },
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  const exited = once(child, "exit");
  try {
    await once(child.stdout, "data");
    const stopping = stopChild(child, { graceMilliseconds: 50 });
    assert.equal(
      await Promise.race([
        stopping.then(() => "stopped"),
        delay(1000, "waiting", { ref: false }),
      ]),
      "stopped",
    );
    assert.deepEqual(await exited, [null, "SIGKILL"]);
    await stopping;
  } finally {
    child.kill("SIGKILL");
    await exited;
  }
});

await test("CLV-145 stopping a detached group also stops a descendant after its leader exits", async () => {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `
const { spawn } = require("node:child_process");
const descendant = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); console.log("ready");'], { stdio: ["ignore", "inherit", "inherit"] });
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`,
    ],
    {
      detached: true,
      env: { ...process.env, NODE_V8_COVERAGE: undefined },
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  const exited = once(child, "exit");
  const closed = once(child, "close");
  try {
    await once(child.stdout, "data");
    await stopChildGroup(child, { graceMilliseconds: 50 });
    assert.deepEqual(await exited, [0, null]);
    assert.equal(
      await Promise.race([
        closed.then(() => "closed"),
        delay(1000, "open", { ref: false }),
      ]),
      "closed",
    );
  } finally {
    killVerificationGroup(Number(child.pid));
    await closed;
  }
});

await test("CLV-145 group cleanup tolerates macOS reaping a terminated leader", async () => {
  const child = spawn(process.execPath, ["-e", ""], {
    env: { ...process.env, NODE_V8_COVERAGE: undefined },
  });
  await once(child, "exit");
  const descriptor = Object.getOwnPropertyDescriptor(process, "kill");
  assert.ok(descriptor);
  const calls: Array<[number, string | number]> = [];
  process.kill = (identifier, signal = "SIGTERM") => {
    calls.push([identifier, signal]);
    throw Object.assign(new Error("group reaping"), {
      code: calls.length === 1 ? "EPERM" : "ESRCH",
    });
  };
  try {
    await stopChildGroup(child, { graceMilliseconds: 50 });
    assert.deepEqual(calls, [
      [-Number(child.pid), "SIGTERM"],
      [-Number(child.pid), 0],
    ]);
  } finally {
    Object.defineProperty(process, "kill", descriptor);
  }
});

await test("CLV-145 group cleanup fails when a group keeps refusing signals", async () => {
  const child = spawn(process.execPath, ["-e", ""], {
    env: { ...process.env, NODE_V8_COVERAGE: undefined },
  });
  await once(child, "exit");
  const descriptor = Object.getOwnPropertyDescriptor(process, "kill");
  assert.ok(descriptor);
  process.kill = () => {
    throw Object.assign(new Error("group refuses"), { code: "EPERM" });
  };
  try {
    await assert.rejects(
      stopChildGroup(child, { graceMilliseconds: 1 }),
      /test-child-process-group-remains/,
    );
  } finally {
    Object.defineProperty(process, "kill", descriptor);
  }
});

const descendant = `
const timer = setInterval(() => {}, 1000);
process.once("SIGTERM", () => setImmediate(() => {
  clearInterval(timer);
  process.disconnect();
}));
process.send("ready");
`;

const launcher = `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], {
  stdio: ["ignore", "ignore", "inherit", "ipc"],
});
process.once("SIGTERM", () => child.kill("SIGTERM"));
child.once("message", () => console.log("ready"));
child.once("close", (code, signal) => {
  writeFileSync("descendant.json", JSON.stringify({ code, signal }));
});
`;

await test("CLV-201 group cleanup lets the launcher stop its covered descendants before signaling survivors", async () => {
  await withFiles({}, async (directory) => {
    const coverage = join(directory, "coverage");
    await mkdir(coverage);
    const child = spawn(process.execPath, ["-e", launcher], {
      cwd: directory,
      detached: true,
      env: { ...process.env, NODE_V8_COVERAGE: coverage },
      stdio: ["ignore", "pipe", "inherit"],
    });
    const descriptor = Object.getOwnPropertyDescriptor(process, "kill");
    assert.ok(descriptor);
    const kill = process.kill.bind(process);
    const premature: number[] = [];
    try {
      await once(child.stdout, "data");
      process.kill = (identifier, signal) => {
        if (
          identifier === -Number(child.pid) &&
          signal === "SIGTERM" &&
          child.exitCode === null &&
          child.signalCode === null
        )
          premature.push(identifier);
        return kill(identifier, signal);
      };
      await stopChildGroup(child);
      assert.deepEqual(premature, [], "the launcher owns graceful shutdown");
      assert.deepEqual(
        JSON.parse(await readFile(join(directory, "descendant.json"), "utf8")),
        { code: 0, signal: null },
      );
      const reports = await readdir(coverage);
      assert.equal(reports.length, 2);
      for (const file of reports)
        assert.ok(
          "result" in
            Object(JSON.parse(await readFile(join(coverage, file), "utf8"))),
        );
    } finally {
      Object.defineProperty(process, "kill", descriptor);
      await stopChildGroup(child);
    }
  });
});
