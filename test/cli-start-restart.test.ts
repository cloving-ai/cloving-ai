import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { scene, withoutChildren } from "./self-host-fixture.ts";

async function launched(first: number) {
  const root = await mkdtemp(join(tmpdir(), "cloving-restart-"));
  try {
    await mkdir(join(root, "src"));
    await mkdir(join(root, "tools"));
    await writeFile(join(root, "package.json"), '{"type":"module"}');
    await copyFile(
      join(import.meta.dirname, "../src/cli.ts"),
      join(root, "src/cli.ts"),
    );
    await symlink(
      join(import.meta.dirname, "../src/cli"),
      join(root, "src/cli"),
    );
    await writeFile(
      join(root, "tools/self-host.ts"),
      `
import { appendFileSync, existsSync } from "node:fs";
const again = existsSync("starts.jsonl");
appendFileSync("starts.jsonl", JSON.stringify({ arguments: process.argv.slice(2), marker: process.env["RESTART_MARKER"] }) + "\\n");
process.exit(again ? 0 : ${String(first)});
`,
    );
    const result = spawnSync(
      process.execPath,
      [join(root, "src/cli.ts"), "start", "--repository", "selected"],
      {
        cwd: root,
        env: {
          ...process.env,
          CLOVING_RUNTIME_DIR: join(root, "run"),
          RESTART_MARKER: "preserved",
        },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    const starts = (await readFile(join(root, "starts.jsonl"), "utf8"))
      .trim()
      .split("\n");
    return { result, starts };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await test("CLV-085 start restarts after 75 with the same arguments and environment, then exits zero", async () => {
  const { result, starts } = await launched(75);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(starts.length, 2);
  assert.equal(starts[0], starts[1]);
  assert.match(String(starts[0]), /selected/);
  assert.match(String(starts[0]), /preserved/);
});

await test("CLV-085 start does not restart after exit one", async () => {
  const { result, starts } = await launched(1);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(starts.length, 1);
});

await test("CLV-085 Control-C through the real CLI stops the host without restarting", () =>
  withoutChildren(async () => {
    const fixture = await scene();
    const daemon = await fixture.start();
    const ended = new Promise<number | null>((settle) =>
      daemon.once("close", settle),
    );
    daemon.kill("SIGINT");
    assert.equal(await ended, 0);
  }));
