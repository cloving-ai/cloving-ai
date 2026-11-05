import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { threadPoolStallExitCode } from "../src/thread-pool-check.ts";
import { withFiles } from "./quality/files-fixture.ts";
import { testMilliseconds } from "./test-timing.ts";

const entry = join(import.meta.dirname, "../src/cli.ts");

await test("CLV-298 the watch command with a stalled thread pool logs threadpool-stalled and exits with the stall exit code", () =>
  withFiles({}, async (root) => {
    const pipe = join(root, "pipe");
    execFileSync("mkfifo", [pipe]);
    const stall = join(root, "stall.mjs");
    await writeFile(
      stall,
      `import { open } from "node:fs";\nopen(${JSON.stringify(pipe)}, "r", () => undefined);\n`,
    );
    const child = spawn(
      process.execPath,
      ["--import", pathToFileURL(stall).href, entry, "watch", "--port", "0"],
      {
        env: {
          ...process.env,
          UV_THREADPOOL_SIZE: "1",
          CLOVING_RUNTIME_DIR: join(root, "run"),
        },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    const errors = { text: "" };
    child.stderr.on("data", (chunk: Buffer) => {
      errors.text += chunk.toString();
    });
    const limit = setTimeout(() => {
      child.kill("SIGKILL");
    }, testMilliseconds(30_000));
    const status = await new Promise<number | null>((settle) => {
      child.once("close", settle);
    });
    clearTimeout(limit);
    assert.equal(status, threadPoolStallExitCode, errors.text);
    assert.match(
      errors.text,
      /^threadpool-stalled ms=\d+ resources=\S*FSReqCallback:1\S*$/m,
    );
  }));
