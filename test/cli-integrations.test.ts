import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { withFiles } from "./quality/files-fixture.ts";

await test("Zapier integration commands delegate with the selected local runtime and literal arguments", async () => {
  await withFiles({}, async (directory) => {
    const executable = join(directory, "cloving-zapier");
    await writeFile(
      executable,
      `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({args:process.argv.slice(2),runtime:process.env.CLOVING_RUNTIME_DIR}));\n`,
    );
    await chmod(executable, 0o700);
    const runtime = join(directory, "runtime");
    const result = await promisify(execFile)(
      process.execPath,
      [
        resolve("src/cli.ts"),
        "integrations",
        "connect",
        "zapier",
        "--workflow",
        "develop",
      ],
      {
        env: {
          ...process.env,
          PATH: `${directory}:${process.env["PATH"] ?? ""}`,
          CLOVING_RUNTIME_DIR: runtime,
        },
      },
    );
    assert.deepEqual(JSON.parse(result.stdout), {
      args: ["connect", "zapier", "--workflow", "develop"],
      runtime,
    });
  });
});

await test("stopping an integration wrapper stops its adapter and waits for shutdown", async () => {
  await withFiles({}, async (directory) => {
    const executable = join(directory, "cloving-zapier");
    const stopped = join(directory, "stopped");
    await writeFile(
      executable,
      `#!${process.execPath}\nconst fs=require('node:fs');process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(stopped)},'stopped');process.exit(0)});setInterval(()=>{},1000);process.stdout.write(String(process.pid)+'\\n');\n`,
    );
    await chmod(executable, 0o700);
    const child = spawn(
      process.execPath,
      [resolve("src/cli.ts"), "integrations", "serve", "zapier"],
      {
        env: {
          ...process.env,
          PATH: `${directory}:${process.env["PATH"] ?? ""}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let adapterPid = 0;
    try {
      const ready: readonly unknown[] = await once(child.stdout, "data");
      adapterPid = Number(String(ready[0]).trim());
      const closed = once(child, "exit");
      child.kill("SIGTERM");
      const status: readonly unknown[] = await closed;
      assert.equal(status[0], 0);
      assert.equal(await readFile(stopped, "utf8"), "stopped");
    } finally {
      child.kill("SIGKILL");
      if (adapterPid > 0) {
        try {
          process.kill(adapterPid, "SIGKILL");
        } catch (error) {
          child.stdout.destroy(
            error instanceof Error && Reflect.get(error, "code") !== "ESRCH"
              ? error
              : undefined,
          );
        }
      }
    }
  });
});
