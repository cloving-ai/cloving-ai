import assert from "node:assert/strict";
import { chmodSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { git } from "./claude-worker-fixture.ts";
import {
  commitFiles,
  redGreen,
  testFile,
  verdict,
  withRedGreen,
} from "./red-green-fixture.ts";

const passing = {
  red: { status: 0, output: "pass" },
  green: { status: 0, output: "pass" },
};

await test("CLV-248 a symlink replaced by a regular test is a changed test", () =>
  withRedGreen(passing, (scene) => {
    rmSync(join(scene.repository, testFile));
    symlinkSync("../fixtures/original.ts", join(scene.repository, testFile));
    const base = commitFiles(scene, { "fixtures/original.ts": "target" });
    git(scene.repository, ["update-ref", "refs/remotes/origin/main", base]);
    rmSync(join(scene.repository, testFile));
    const head = commitFiles(scene, { [testFile]: "regular test" });
    const result = redGreen(
      { ...scene, head },
      {
        settings: {
          test: [
            process.execPath,
            "-e",
            'console.log(require("node:fs").readFileSync(process.argv[1],"utf8"))',
          ],
          testFiles: ["test/"],
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      verdict: "false-red",
      base,
      head,
      files: [testFile],
      output: "regular test\n",
    });
  }));

await test("CLV-248 a leading space in a test prefix and path is preserved", () =>
  withRedGreen(passing, (scene) => {
    const file = " test/sum.test.ts";
    const head = commitFiles(scene, { [file]: "test" });
    const result = redGreen(
      { ...scene, head },
      {
        settings: {
          test: [process.execPath, "-e", 'console.log("selected")'],
          testFiles: [" test/"],
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      verdict: "false-red",
      base: scene.base,
      head,
      files: [file],
      output: "selected\n",
    });
  }));

await test("CLV-248 literal wildcard test paths do not remove excluded base files", () =>
  withRedGreen(passing, (scene) => {
    const base = commitFiles(scene, {
      "test/foox.ts": "keep",
      "test/array1.ts": "keep",
    });
    git(scene.repository, ["update-ref", "refs/remotes/origin/main", base]);
    for (const name of ["foox.ts", "array1.ts"])
      rmSync(join(scene.repository, "test", name));
    const head = commitFiles(scene, {
      "test/foo*.ts": "new",
      "test/array[1].ts": "new",
    });
    const result = redGreen(
      { ...scene, head },
      {
        settings: {
          test: [
            process.execPath,
            "-e",
            'console.log(JSON.stringify(require("node:fs").readdirSync("test").sort()))',
          ],
          testFiles: ["test/foo*.ts", "test/array[1].ts"],
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      verdict: "false-red",
      base,
      head,
      files: ["test/array[1].ts", "test/foo*.ts"],
      output:
        JSON.stringify([
          "array1.ts",
          "array[1].ts",
          "foo*.ts",
          "foox.ts",
          "sum.test.ts",
        ]) + "\n",
    });
  }));

await test("CLV-248 file selection includes changed and renamed tests, with spaces, and excludes deletions", () =>
  withRedGreen(passing, (scene) => {
    const base = commitFiles(scene, {
      "test/deleted.ts": "old",
      "test/changed.ts": "old",
    });
    git(scene.repository, ["update-ref", "refs/remotes/origin/main", base]);
    git(scene.repository, ["mv", testFile, "test/renamed sum.test.ts"]);
    rmSync(join(scene.repository, "test/deleted.ts"));
    const head = commitFiles(scene, {
      "test/changed.ts": "new",
      "test-other.ts": "ignored",
    });
    const result = redGreen(
      { ...scene, head },
      {
        settings: {
          test: [
            process.execPath,
            "-e",
            "console.log(JSON.stringify(process.argv.slice(1)))",
          ],
          testFiles: ["test/"],
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const files = ["test/changed.ts", "test/renamed sum.test.ts"];
    assert.deepEqual(JSON.parse(result.stdout), {
      verdict: "false-red",
      base,
      head,
      files,
      output: JSON.stringify(files) + "\n",
    });
    assert.equal(
      git(scene.repository, ["worktree", "list", "--porcelain"]).split(
        "worktree ",
      ).length,
      2,
    );
  }));

await test("CLV-248 the red overlay preserves executable test modes", () =>
  withRedGreen(passing, (scene) => {
    commitFiles(scene, {
      [testFile]:
        '#!/bin/sh\nif [ "$(cat src/sum.ts)" = head ]; then exit 0; fi\necho ERR_ASSERTION\nexit 1\n',
    });
    chmodSync(join(scene.repository, testFile), 0o755);
    git(scene.repository, ["add", testFile]);
    git(scene.repository, [
      "commit",
      "--quiet",
      "-m",
      "Make the test executable",
    ]);
    const head = git(scene.repository, ["rev-parse", "HEAD"]);
    verdict(
      {
        ...scene,
        head,
        settings: { test: ["./" + testFile], testFiles: ["test/"] },
      },
      "accepted",
    );
  }));
