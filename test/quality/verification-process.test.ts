import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { captureExecution } from "../../quality/verification-process.ts";
import { withFiles } from "./files-fixture.ts";
import { withVerification } from "./verification-fixture.ts";
import { killVerificationGroup } from "../../quality/verification-process-group.ts";
import { readFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";

await test("QG-10 ends the owned process group after a check exits", async () => {
  await withFiles(
    {
      "check.js":
        'const { spawn } = require("node:child_process"); const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); console.log(child.pid); child.unref();',
    },
    async (directory) => {
      const result = await captureExecution({
        id: "descendant",
        executable: process.execPath,
        arguments: [join(directory, "check.js")],
        directory,
        timeoutMilliseconds: 1000,
      });
      const child = Number(result.stdout.trim());
      assert.ok(Number.isSafeInteger(child) && child > 0);
      const group = result.processGroup;
      assert.ok(group);
      try {
        assert.throws(() => {
          process.kill(child, 0);
        }, /ESRCH/);
      } finally {
        killVerificationGroup(group);
      }
    },
  );
});

for (const [name, source, diagnostic] of [
  ["timeout", "setInterval(() => {}, 1000);", "verification-timeout"],
  [
    "output overflow",
    'process.stdout.write("x".repeat(2 * 1024 * 1024));',
    "verification-output-overflow",
  ],
] as const) {
  await test(`QG-10 records actual ${name} as failed execution`, async () => {
    await withVerification(source, async (plan) => {
      const command = plan.commands[0];
      assert.ok(command);
      const result = await captureExecution(command);
      assert.equal(result.error, diagnostic);
      assert.ok(Buffer.byteLength(result.stdout) <= 1024 * 1024);
    });
  });
}

await test("QG-09 ignores inherited Node preloads and module lookup paths", async () => {
  await withVerification(
    "console.log(String(process.env.NODE_OPTIONS), String(process.env.NODE_PATH));",
    async (plan) => {
      const command = plan.commands[0];
      assert.ok(command);
      const names = ["NODE_OPTIONS", "NODE_PATH"];
      const original = names.map((name) => process.env[name]);
      for (const name of names) process.env[name] = "untrusted-preload";
      try {
        const result = await captureExecution(command);
        assert.equal(result.exit, 0);
        assert.equal(result.stdout, "undefined undefined\n");
      } finally {
        for (const [index, name] of names.entries()) {
          const value = original[index];
          if (value === undefined) Reflect.deleteProperty(process.env, name);
          else process.env[name] = value;
        }
      }
    },
  );
});

await test("QG-10 bounds capture when an escaped descendant keeps output pipes open", async () => {
  await withVerification(
    'const { spawn } = require("node:child_process"); const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: ["ignore", process.stdout, process.stderr] }); require("node:fs").writeFileSync("child.pid", String(child.pid)); child.unref();',
    async (plan) => {
      const command = plan.commands[0];
      assert.ok(command);
      try {
        const result = await Promise.race([
          captureExecution(command),
          setTimeout(2500, "watchdog", { ref: false }),
        ]);
        assert.ok(typeof result === "object");
        assert.equal(result.error, "verification-timeout");
      } finally {
        const child = Number(
          await readFile(join(command.directory, "child.pid"), "utf8"),
        );
        assert.ok(Number.isSafeInteger(child) && child > 0);
        process.kill(child, "SIGKILL");
      }
    },
  );
});
