import assert from "node:assert/strict";
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
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

await test("MCP integration commands delegate with the selected local runtime and literal arguments", async () => {
  await withFiles({}, async (directory) => {
    const executable = join(directory, "cloving-mcp");
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
        "serve",
        "mcp",
        "--name",
        "studio",
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
      args: ["serve", "mcp", "--name", "studio"],
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
    const executable = join(root, "cloving-mcp");
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
    const argumentsList = ["serve", "mcp", "--name", "a literal name; $()"];
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
    const executable = join(directory, "cloving-mcp");
    const stopped = join(directory, "stopped");
    await writeFile(
      executable,
      `#!${process.execPath}\nconst fs=require('node:fs');process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(stopped)},'stopped');process.exit(0)});setInterval(()=>{},1000);process.stdout.write(String(process.pid)+'\\n');\n`,
    );
    await chmod(executable, 0o700);
    const child = spawn(
      process.execPath,
      [resolve("src/cli.ts"), "integrations", "serve", "mcp"],
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

function cloving(
  argumentsList: readonly string[],
  options: { readonly directory: string; readonly path: string },
) {
  return spawnSync(
    process.execPath,
    [resolve("src/cli.ts"), ...argumentsList],
    {
      cwd: options.directory,
      encoding: "utf8",
      env: { ...process.env, PATH: options.path },
    },
  );
}

async function markedIntegration(directory: string): Promise<string> {
  const marker = join(directory, "started");
  const executable = join(directory, "cloving-mcp");
  await writeFile(
    executable,
    `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'started');\n`,
  );
  await chmod(executable, 0o700);
  return marker;
}

await test("CLV-331 a target other than mcp starts no integration executable and exits with a usage error", async () => {
  await withFiles({}, async (directory) => {
    const marker = await markedIntegration(directory);
    const result = cloving(["integrations", "serve", "other"], {
      directory,
      path: `${directory}:${process.env["PATH"] ?? ""}`,
    });
    assert.equal(result.stderr, "unknown-integration: other\n");
    assert.equal(result.stdout, "");
    assert.equal(result.status, 2);
    assert.equal(existsSync(marker), false);
  });
});

await test("CLV-331 a missing integration target starts no integration executable and exits with a usage error", async () => {
  await withFiles({}, async (directory) => {
    const marker = await markedIntegration(directory);
    for (const argumentsList of [
      ["integrations", "serve"],
      ["integrations", "serve", "--help"],
      ["integrations"],
    ]) {
      const result = cloving(argumentsList, {
        directory,
        path: `${directory}:${process.env["PATH"] ?? ""}`,
      });
      assert.equal(
        result.stderr,
        "missing-integration: run cloving --help for usage.\n",
      );
      assert.equal(result.stdout, "");
      assert.equal(result.status, 2);
    }
    assert.equal(existsSync(marker), false);
  });
});

await test("CLV-331 a missing integration executable names the Cloving relay integration package and the executable", async () => {
  await withFiles({}, (directory) => {
    const result = cloving(["integrations", "serve", "mcp"], {
      directory,
      path: directory,
    });
    assert.equal(
      result.stderr,
      "tool-unavailable: Install the Cloving relay integration package (cloving-mcp).\n",
    );
    assert.notEqual(result.status, 0);
    assert.notEqual(result.status, null);
  });
});

await test("CLV-331 the help and the README name only the mcp integration target and the Cloving relay integration package", async () => {
  await withFiles({}, (directory) => {
    const path = process.env["PATH"] ?? "";
    const top = cloving(["--help"], { directory, path });
    assert.equal(top.status, 0, top.stderr);
    const lines = top.stdout.split("\n");
    assert.ok(
      lines.includes("       cloving integrations <command> mcp [options]"),
    );
    assert.ok(
      lines.includes(
        "  integrations        Connect and manage encrypted MCP access.",
      ),
    );
    const mcp = cloving(["mcp", "--help"], { directory, path });
    assert.equal(mcp.status, 0, mcp.stderr);
    assert.ok(
      mcp.stdout
        .split("\n")
        .includes(
          "--connection launches the encrypted remote bridge from the Cloving relay integration package.",
        ),
    );
  });
  const section = (await readFile("README.md", "utf8"))
    .split("### Use Cloving from an MCP client\n")[1]
    ?.split(/^#{2,3} /m)[0];
  assert.match(
    String(section),
    /^To use a workflow computer from a harness on another machine, install the Cloving relay integration package on both machines\. /m,
  );
});
