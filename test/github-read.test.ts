import assert from "node:assert/strict";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { githubReader } from "../src/daemon/github-read.ts";

await test("CLV-321 the daemon reads a GitHub API path with the configured command in the service repository", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cloving-github-read-"));
  try {
    const program = join(directory, "fake gh.mjs");
    await writeFile(
      program,
      "process.stdout.write(JSON.stringify({ arguments: process.argv.slice(2), directory: process.cwd() }));\n",
    );
    const read = githubReader({
      repository: directory,
      githubCommand: [process.execPath, program],
    });
    const value = await read.read("repos/cloving-ai/cloving-ai/issues/586");
    assert.deepEqual(value, {
      arguments: ["api", "repos/cloving-ai/cloving-ai/issues/586"],
      directory: await realpath(directory),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

await test("CLV-321 with no configured command, the daemon reads GitHub with gh from the PATH", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cloving-github-gh-"));
  const path = process.env["PATH"];
  try {
    const program = join(directory, "gh");
    await writeFile(
      program,
      `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({ state: "closed", path: process.argv.at(-1) }));\n`,
    );
    await chmod(program, 0o755);
    process.env["PATH"] = `${directory}:${String(path)}`;
    const reader = githubReader({ repository: directory });
    assert.deepEqual(
      await reader.read("repos/cloving-ai/cloving-ai/issues/586"),
      {
        state: "closed",
        path: "repos/cloving-ai/cloving-ai/issues/586",
      },
    );
  } finally {
    process.env["PATH"] = path;
    await rm(directory, { recursive: true, force: true });
  }
});
