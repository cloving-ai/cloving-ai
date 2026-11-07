import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { withFiles } from "./quality/files-fixture.ts";
import { runtimeDirectory } from "../src/cli/runtime-directory.ts";

await test("encrypted MCP setup and remote stdio delegate to the MCP bridge with literal arguments", async () => {
  await withFiles({}, async (directory) => {
    const executable = join(directory, "cloving-mcp");
    await writeFile(
      executable,
      `#!${process.execPath}\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n`,
    );
    await chmod(executable, 0o700);
    for (const argumentsList of [
      ["integrations", "connect", "mcp", "--workflow", "develop"],
      ["integrations", "pair", "mcp", "--name", "a literal name; $()"],
      ["mcp", "--connection", "my-studio"],
    ]) {
      const reply = await promisify(execFile)(
        process.execPath,
        [resolve("src/cli.ts"), ...argumentsList],
        {
          cwd: directory,
          env: {
            ...process.env,
            PATH: `${directory}:${process.env["PATH"] ?? ""}`,
          },
        },
      );
      assert.deepEqual(JSON.parse(reply.stdout), argumentsList.slice(1));
    }
    for (const argumentsList of [
      ["--repository", directory, "mcp", "--connection", "my-studio"],
      ["mcp", "--repository", directory, "--connection", "my-studio"],
    ]) {
      const reply = await promisify(execFile)(
        process.execPath,
        [resolve("src/cli.ts"), ...argumentsList],
        {
          env: {
            ...process.env,
            PATH: `${directory}:${process.env["PATH"] ?? ""}`,
          },
        },
      );
      assert.deepEqual(JSON.parse(reply.stdout), ["--connection", "my-studio"]);
    }
  });
});

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

await test("repository selectors choose the matching project's integration runtime without an override", async () => {
  await withFiles({ "first/file": "", "second/file": "" }, async (root) => {
    const first = join(root, "first");
    const second = join(root, "second");
    for (const directory of [first, second])
      execFileSync("git", ["init", "-q", directory]);
    const executable = join(root, "cloving-zapier");
    await writeFile(
      executable,
      `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({args:process.argv.slice(2),runtime:process.env.CLOVING_RUNTIME_DIR}));\n`,
    );
    await chmod(executable, 0o700);
    const environment = {
      ...process.env,
      CLOVING_RUNTIME_DIR: undefined,
      XDG_RUNTIME_DIR: "",
      XDG_STATE_HOME: join(root, "state"),
      PATH: `${root}:${process.env["PATH"] ?? ""}`,
    };
    const argumentsList = ["serve", "zapier", "--name", "a literal name; $()"];
    for (const [directory, selected, argumentsGiven] of [
      [
        first,
        second,
        ["--repository", second, "integrations", ...argumentsList],
      ],
      [first, first, ["integrations", ...argumentsList]],
      [second, second, ["integrations", ...argumentsList]],
      [
        first,
        second,
        ["integrations", ...argumentsList, "--repository", second],
      ],
      [
        first,
        second,
        [`--repository=${second}`, "integrations", ...argumentsList],
      ],
    ] as const) {
      const result = await promisify(execFile)(
        process.execPath,
        [resolve("src/cli.ts"), ...argumentsGiven],
        { cwd: directory, env: environment },
      );
      assert.deepEqual(JSON.parse(result.stdout), {
        args: argumentsList,
        runtime: runtimeDirectory(environment, selected),
      });
    }
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
      const ready = await once(child.stdout, "data");
      assert.ok(Buffer.isBuffer(ready[0]));
      adapterPid = Number(ready[0].toString().trim());
      const closed = once(child, "exit");
      child.kill("SIGTERM");
      const status = await closed;
      assert.ok(typeof status[0] === "number");
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
