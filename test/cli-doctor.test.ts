import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { test } from "node:test";
import { withFiles } from "./quality/files-fixture.ts";
import { fields, items } from "./service-fixture.ts";

await test("CLV-207 doctor reports a required git failure outside a repository", () =>
  withFiles({}, (directory) => {
    const result = spawnSync(
      process.execPath,
      [resolve("src/cli.ts"), "doctor", "--json"],
      {
        cwd: directory,
        encoding: "utf8",
        timeout: 15000,
      },
    );
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const report = fields(JSON.parse(result.stdout));
    assert.equal(report["version"], 1);
    const git = fields(items(report["checks"])[0]);
    assert.equal(git["code"], "git-repository");
    assert.equal(git["result"], "fail");
    assert.equal(git["required"], true);
    assert.match(String(git["fix"]), /git init/);
  }));

await test("CLV-207 doctor help, invalid invocations and human output use the CLI contract", () =>
  withFiles({}, (directory) => {
    const cli = (...argumentsList: string[]) =>
      spawnSync(
        process.execPath,
        [resolve("src/cli.ts"), "doctor", ...argumentsList],
        { cwd: directory, encoding: "utf8", timeout: 15000 },
      );
    const human = cli();
    assert.equal(human.status, 1);
    assert.match(human.stdout, /fail\s+git-repository.*git init.*required/);
    const help = cli("--help");
    assert.equal(help.status, 0);
    assert.match(help.stdout, /Usage: cloving doctor/);
    for (const argumentsList of [
      ["unexpected"],
      ["--prompt", "task"],
      ["--unknown"],
    ])
      assert.equal(cli(...argumentsList).status, 2);
  }));
