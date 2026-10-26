import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { withFiles } from "./quality/files-fixture.ts";
import { operatorFiles } from "./workflow-folder-fixture.ts";
import { reached } from "./self-host-fixture.ts";
import { stopChildGroup } from "./stop-child.ts";

for (const signal of ["SIGINT", "SIGTERM"] as const)
  await test(`CLV-224 workflow tests forward ${signal} to the Node runner`, () =>
    withFiles(
      {
        ...operatorFiles("project", "develop"),
        "repo/.cloving/workflows/develop.test.ts": `
import { test } from "node:test";
await test("waiting scenario", async () => {
  process.stdout.write(["workflow", "runner", "ready"].join("-") + String.fromCharCode(10));
  await new Promise(() => { setInterval(() => {}, 1000); });
});`,
      },
      async (root) => {
        const child = spawn(
          process.execPath,
          [resolve("src/cli.ts"), "workflows", "test", "develop"],
          {
            cwd: join(root, "repo"),
            detached: true,
            env: {
              ...process.env,
              HOME: root,
              XDG_CONFIG_HOME: join(root, "config"),
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        const closed = new Promise<number | null>((settle) =>
          child.once("close", settle),
        );
        const output = { text: "" };
        for (const stream of [child.stdout, child.stderr])
          stream.on("data", (bytes: Buffer) => {
            output.text += bytes.toString();
          });
        try {
          await reached(() =>
            Promise.resolve(
              output.text.includes("workflow-runner-ready") ? true : undefined,
            ),
          );
          assert.equal(child.kill(signal), true);
          assert.equal(await closed, 1, output.text);
        } finally {
          await stopChildGroup(child);
        }
      },
    ));

await test("CLV-224 workflow inspection errors retain a failure status", () =>
  withFiles({ "repo/marker": "" }, (root) => {
    const result = spawnSync(
      process.execPath,
      [
        resolve("src/cli.ts"),
        "workflows",
        "list",
        "--repository",
        join(root, "missing"),
      ],
      {
        cwd: join(root, "repo"),
        encoding: "utf8",
        timeout: 30000,
        env: {
          ...process.env,
          HOME: root,
          XDG_CONFIG_HOME: join(root, "config"),
        },
      },
    );
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /workflow-inspection-failed/);
  }));
