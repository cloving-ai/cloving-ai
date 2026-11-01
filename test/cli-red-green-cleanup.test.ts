import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { alive, git, until } from "./claude-worker-fixture.ts";
import { stopChild } from "./stop-child.ts";
import {
  redGreen,
  spawnRedGreen,
  runs,
  stopHeld,
  verdict,
  withRedGreen,
} from "./red-green-fixture.ts";

const passing = {
  red: { status: 0, output: "pass" },
  green: { status: 0, output: "pass" },
};

for (const stop of [
  "setInterval(()=>{},1000)",
  'process.kill(process.pid,"SIGTERM")',
])
  await test(`CLV-248 an unfinished assertion red is rejected: ${stop}`, () =>
    withRedGreen(passing, (scene) => {
      const configured = {
        ...scene,
        settings: {
          ...scene.settings,
          test: [
            process.execPath,
            "-e",
            `if(require("node:fs").readFileSync("src/sum.ts","utf8")==="base"){console.log("ERR_ASSERTION");${stop}}else console.log("head passed")`,
          ],
        },
      };
      const previous = process.env["CLOVING_COMMAND_SECONDS"];
      process.env["CLOVING_COMMAND_SECONDS"] = "1";
      try {
        assert.match(
          String(verdict(configured, "red-not-assertion")["output"]),
          /ERR_ASSERTION/,
        );
      } finally {
        if (previous === undefined)
          delete process.env["CLOVING_COMMAND_SECONDS"];
        else process.env["CLOVING_COMMAND_SECONDS"] = previous;
      }
    }));

await test("CLV-248 a detached descendant with inherited pipes cannot prevent timeout cleanup", () =>
  withRedGreen(passing, async (scene) => {
    const marker = join(scene.directory, "escaped-");
    const source = `const fs=require("node:fs");const phase=fs.readFileSync("src/sum.ts","utf8");const code='require("node:fs").writeFileSync('+JSON.stringify(${JSON.stringify(marker)}+phase)+',JSON.stringify({pid:process.pid}));setInterval(()=>{},1000)';require("node:child_process").spawn(process.execPath,["-e",code],{detached:true,stdio:"inherit"}).unref();`;
    const { child, result } = spawnRedGreen(scene, {
      settings: { ...scene.settings, test: [process.execPath, "-e", source] },
      environment: { CLOVING_COMMAND_SECONDS: "1" },
    });
    try {
      await until(() => result.closed);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /"verdict":"red-not-assertion"/);
      assert.match(result.stdout, /timed out/);
      assert.equal(
        git(scene.repository, ["worktree", "list", "--porcelain"]).split(
          "worktree ",
        ).length,
        2,
      );
    } finally {
      stopHeld(marker + "base");
      stopHeld(marker + "head");
      await stopChild(child, { graceMilliseconds: 50 });
    }
  }));

await test("CLV-248 verdicts preserve the caller branch, index and dirty files", () =>
  withRedGreen(passing, (scene) => {
    writeFileSync(join(scene.repository, "README.md"), "staged");
    git(scene.repository, ["add", "README.md"]);
    writeFileSync(join(scene.repository, "README.md"), "unstaged");
    writeFileSync(join(scene.repository, "loose"), "untracked");
    const before = git(scene.repository, ["status", "--porcelain=v1"]);
    const index = git(scene.repository, ["write-tree"]);
    verdict(scene, "false-red");
    assert.equal(
      git(scene.repository, ["symbolic-ref", "HEAD"]),
      "refs/heads/feature",
    );
    assert.equal(git(scene.repository, ["rev-parse", "HEAD"]), scene.head);
    assert.equal(git(scene.repository, ["status", "--porcelain=v1"]), before);
    assert.equal(git(scene.repository, ["write-tree"]), index);
    assert.equal(
      readFileSync(join(scene.repository, "README.md"), "utf8"),
      "unstaged",
    );
    assert.equal(
      readFileSync(join(scene.repository, "loose"), "utf8"),
      "untracked",
    );
  }));

for (const phase of ["prepare", "test"])
  await test(`CLV-248 SIGTERM during ${phase} removes its tree and child process`, () =>
    withRedGreen(passing, async (scene) => {
      const marker = join(scene.directory, "held.json");
      const hold = [
        process.execPath,
        "-e",
        `const fs=require("node:fs");process.on("SIGTERM",()=>{});fs.writeFileSync(${JSON.stringify(marker + ".staged")},JSON.stringify({pid:process.pid,directory:process.cwd()}));fs.renameSync(${JSON.stringify(marker + ".staged")},${JSON.stringify(marker)});setInterval(()=>{},1000);`,
      ];
      const { child, result } = spawnRedGreen(scene, {
        settings: { ...scene.settings, [phase]: hold },
      });
      try {
        await until(() => existsSync(marker));
        const held: unknown = JSON.parse(readFileSync(marker, "utf8"));
        const pid = Number(Reflect.get(Object(held), "pid"));
        child.kill("SIGTERM");
        await until(() => result.closed);
        assert.equal(result.status, 1, result.stderr);
        assert.equal(alive(pid), false);
        assert.equal(
          existsSync(String(Reflect.get(Object(held), "directory"))),
          false,
        );
        assert.equal(
          git(scene.repository, ["worktree", "list", "--porcelain"]).split(
            "worktree ",
          ).length,
          2,
        );
      } finally {
        stopHeld(marker);
        await stopChild(child, { graceMilliseconds: 50 });
      }
    }));

await test("CLV-248 a missing prepare executable gives prepare-failed and cleans both trees", () =>
  withRedGreen(passing, (scene) => {
    const configured = {
      ...scene,
      settings: {
        ...scene.settings,
        prepare: ["cloving-missing-prepare-executable"],
      },
    };
    assert.match(
      String(verdict(configured, "prepare-failed")["output"]),
      /ENOENT/,
    );
    assert.deepEqual(runs(scene), []);
  }));

await test("CLV-248 a test timeout gives red-not-assertion and removes both trees", () =>
  withRedGreen(passing, (scene) => {
    const result = redGreen(scene, {
      settings: {
        ...scene.settings,
        test: [process.execPath, "-e", "setInterval(()=>{},1000)"],
      },
      environment: { CLOVING_COMMAND_SECONDS: "1" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"verdict":"red-not-assertion"/);
    assert.match(result.stdout, /timed out/);
    assert.equal(
      git(scene.repository, ["worktree", "list", "--porcelain"]).split(
        "worktree ",
      ).length,
      2,
    );
  }));
