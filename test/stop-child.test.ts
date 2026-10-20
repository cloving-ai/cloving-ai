import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { withFiles } from "./quality/files-fixture.ts";
import { stopChild, stopChildGroup } from "./stop-child.ts";
import { killVerificationGroup } from "../quality/verification-process-group.ts";

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
