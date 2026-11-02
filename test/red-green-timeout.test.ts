import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { startCommand } from "../src/daemon/command-process.ts";
import { record } from "../src/protocol.ts";
import { alive, git, until } from "./claude-worker-fixture.ts";
import { fakeCommandClock } from "./command-worker-fixture.ts";
import {
  redGreenEntry,
  stopHeld,
  withRedGreen,
  type RedGreenScene,
} from "./red-green-fixture.ts";

for (const phase of ["prepare", "test"])
  await test(`CLV-248 the operator command timeout during ${phase} removes its tree and descendants`, () =>
    withRedGreen(
      {
        red: { status: 0, output: "pass" },
        green: { status: 0, output: "pass" },
      },
      async (scene) => {
        const marker = join(scene.directory, "held");
        const hold = heldCommand(marker);
        const previous = {
          settings: process.env["CLOVING_RED_GREEN"],
          seconds: process.env["CLOVING_COMMAND_SECONDS"],
        };
        process.env["CLOVING_RED_GREEN"] = JSON.stringify({
          ...scene.settings,
          [phase]: hold,
        });
        process.env["CLOVING_COMMAND_SECONDS"] = "60";
        const before = git(scene.repository, ["status", "--porcelain=v1"]);
        const clock = fakeCommandClock(Date.now());
        const running = startCommand(
          {
            command: [process.execPath, redGreenEntry, "red-green"],
            directory: scene.repository,
            folder: scene.directory,
            payload: JSON.stringify({ head: scene.head }),
            runId: "run-1",
            operationId: "check-1",
            seconds: 60,
          },
          clock.clock,
        );
        try {
          await until(
            () => existsSync(marker) && existsSync(marker + ".child"),
          );
          clock.tick(60000);
          assert.equal((await running.ended).reason, "command-timeout");
          await assertStopped(scene, { marker, before });
        } finally {
          running.stop();
          await running.ended;
          stopHeld(marker);
          stopHeld(marker + ".child");
          removeHeldTree(scene.repository, marker);
          if (previous.settings === undefined)
            delete process.env["CLOVING_RED_GREEN"];
          else process.env["CLOVING_RED_GREEN"] = previous.settings;
          if (previous.seconds === undefined)
            delete process.env["CLOVING_COMMAND_SECONDS"];
          else process.env["CLOVING_COMMAND_SECONDS"] = previous.seconds;
        }
      },
    ));

function removeHeldTree(repository: string, marker: string): void {
  if (!existsSync(marker)) return;
  const held = record(JSON.parse(readFileSync(marker, "utf8")));
  const tree = held?.["directory"];
  assert.ok(typeof tree === "string");
  if (!existsSync(tree)) return;
  git(repository, ["worktree", "remove", "--force", tree]);
  rmSync(dirname(tree), { recursive: true, force: true });
}

function heldCommand(marker: string): string[] {
  const nested = `const fs=require("node:fs");fs.writeFileSync(${JSON.stringify(marker + ".child.staged")},JSON.stringify({pid:process.pid}));fs.renameSync(${JSON.stringify(marker + ".child.staged")},${JSON.stringify(marker + ".child")});setInterval(()=>{},1000)`;
  return [
    process.execPath,
    "-e",
    `const fs=require("node:fs");require("node:child_process").spawn(process.execPath,["-e",${JSON.stringify(nested)}],{stdio:"inherit"});fs.writeFileSync(${JSON.stringify(marker + ".staged")},JSON.stringify({pid:process.pid,directory:process.cwd()}));fs.renameSync(${JSON.stringify(marker + ".staged")},${JSON.stringify(marker)});setInterval(()=>{},1000)`,
  ];
}

async function assertStopped(
  scene: RedGreenScene,
  options: { readonly marker: string; readonly before: string },
): Promise<void> {
  const { marker, before } = options;
  const held = record(JSON.parse(readFileSync(marker, "utf8")));
  const descendant = record(
    JSON.parse(readFileSync(marker + ".child", "utf8")),
  );
  const directory = held?.["directory"];
  const pid = held?.["pid"];
  const descendantPid = descendant?.["pid"];
  assert.ok(typeof directory === "string");
  assert.ok(typeof pid === "number");
  assert.ok(typeof descendantPid === "number");
  await until(() => !existsSync(directory));
  assert.equal(alive(pid), false);
  assert.equal(alive(descendantPid), false);
  assert.equal(
    git(scene.repository, ["worktree", "list", "--porcelain"]).split(
      "worktree ",
    ).length,
    2,
  );
  assert.equal(git(scene.repository, ["status", "--porcelain=v1"]), before);
  assert.equal(git(scene.repository, ["rev-parse", "HEAD"]), scene.head);
  assert.equal(
    git(scene.repository, ["symbolic-ref", "HEAD"]),
    "refs/heads/feature",
  );
}
