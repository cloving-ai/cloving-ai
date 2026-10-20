import { stopChildGroup } from "./stop-child.ts";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { withFiles } from "./quality/files-fixture.ts";
import { call } from "./service-fixture.ts";
import { ended, reached } from "./self-host-fixture.ts";

const executable = resolve("tools/self-host.ts");

function environment(root: string): NodeJS.ProcessEnv {
  return {
    PATH: [
      join(root, "bin"),
      dirname(process.execPath),
      process.env["PATH"],
    ].join(delimiter),
    HOME: root,
    NODE_V8_COVERAGE: process.env["NODE_V8_COVERAGE"],
    CLOVING_WATCH_PORT: "off",
  };
}

await test("CLV-124 the launcher requires a private runtime location", () =>
  withFiles({}, (root) => {
    const result = spawnSync(process.execPath, [executable], {
      cwd: root,
      env: environment(root),
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /The start program needs --runtime/);
  }));

for (const command of ["{}", "[1]"]) {
  await test(`CLV-124 the launcher refuses invalid command lists before compiling ${command}`, () =>
    withFiles({}, async (root) => {
      const result = spawnSync(
        process.execPath,
        [executable, "--runtime", join(root, "host/run")],
        {
          cwd: root,
          env: { ...environment(root), CLOVING_CLAUDE_COMMAND: command },
          encoding: "utf8",
          timeout: 5000,
        },
      );
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(
        result.stderr,
        /CLOVING_CLAUDE_COMMAND is not a JSON list of texts/,
      );
      await assert.rejects(lstat(join(root, "host")), { code: "ENOENT" });
    }));
}

async function idleLauncher(root: string, worker: string): Promise<void> {
  await mkdir(join(root, "bin"));
  for (const name of ["claude", "codex"]) {
    const file = join(root, "bin", name);
    await writeFile(
      file,
      `#!${process.execPath}\nimport { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(join(root, "worker-called"))}, "called");`,
    );
    await chmod(file, 0o700);
  }
  const child = spawn(
    process.execPath,
    [executable, "--runtime", join(root, "host/run")],
    {
      cwd: root,
      env: { ...environment(root), CLOVING_WORKER: worker },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (bytes: Buffer) => {
      output += bytes.toString();
    });
  try {
    await reached(() => {
      assert.equal(child.exitCode, null, output);
      return Promise.resolve(
        output.includes("Cloving runs") ? true : undefined,
      );
    });
    const status = await call(
      { runtimeDirectory: join(root, "host/run") },
      { operation: "status", parameters: {} },
    );
    assert.deepEqual(status["runs"], []);
    assert.deepEqual(status["workflowRefusals"], []);
    assert.match(output, /cloving status/);
    for (const name of ["worker-called", ".cloving", ".config"])
      await assert.rejects(lstat(join(root, name)), { code: "ENOENT" });
    assert.equal(await ended(child), 0);
  } finally {
    await stopChildGroup(child);
  }
}

for (const worker of ["claude", "codex"]) {
  await test(`CLV-124 default ${worker} configuration starts without executing a worker`, () =>
    withFiles({}, (root) => idleLauncher(root, worker)));
}
