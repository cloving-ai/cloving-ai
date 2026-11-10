import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { parseChangedPaths } from "../quality/command.ts";
import { releaseWorkflow, steps } from "./release-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";
import { testMilliseconds } from "./test-timing.ts";

const pullRequest = "${{ github.event_name == 'pull_request' }}";

await test("a pull request gives the gate the list of its changed paths, and other events give no list", async () => {
  const workflow = await releaseWorkflow();
  for (const name of ["quality_macos", "quality_linux_node"] as const) {
    const jobSteps = steps(workflow, name);
    const checkout = jobSteps.find((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    assert.equal(checkout?.with?.["fetch-depth"], 2, name);
    const listed = jobSteps.findIndex((step) => step.id === "changed-paths");
    const gate = jobSteps.findIndex(
      (step) => step.run === "npm run check:quality",
    );
    assert.ok(listed >= 0 && listed < gate, name);
    assert.equal(jobSteps[listed]?.if, pullRequest);
    assert.equal(jobSteps[listed].env, undefined);
    assert.equal(jobSteps[gate]?.env?.["CLOVING_CHANGED_PATHS"], undefined);
    assert.equal(workflow.jobs[name].env?.["CLOVING_CHANGED_PATHS"], undefined);
  }
});

function git(directory: string, ...command: readonly string[]): string {
  const result = spawnSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      ...command,
    ],
    {
      cwd: directory,
      env: {
        PATH: process.env["PATH"],
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
      encoding: "utf8",
      timeout: testMilliseconds(10_000),
    },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function mergedRepository(directory: string): string {
  const repository = join(directory, "repository");
  git(repository, "init", "-q", "-b", "main");
  git(repository, "add", ".");
  git(repository, "commit", "-qm", "Base");
  git(repository, "checkout", "-qb", "change");
  git(repository, "mv", "bin/old.ts", "src/new a.ts");
  spawnSync("/bin/sh", ["-c", "echo changed >> src/cli/watch-view.ts"], {
    cwd: repository,
  });
  git(repository, "commit", "-qam", "Change");
  git(repository, "checkout", "-q", "main");
  spawnSync("/bin/sh", ["-c", "echo moved >> README.md"], {
    cwd: repository,
  });
  git(repository, "commit", "-qam", "Main moves");
  git(repository, "merge", "-q", "--no-ff", "-m", "Merge", "change");
  return repository;
}

await test("the changed paths step writes the paths that the pull request changes against its base, with both names of a move", async () => {
  const workflow = await releaseWorkflow();
  const run = steps(workflow, "quality_linux_node").find(
    (step) => step.id === "changed-paths",
  )?.run;
  assert.ok(typeof run === "string");
  for (const name of ["quality_macos", "quality_linux_node"] as const)
    assert.equal(
      steps(workflow, name).find((step) => step.id === "changed-paths")?.run,
      run,
    );
  await withFiles(
    {
      "repository/README.md": "base\n",
      "repository/bin/old.ts": "export {};\n",
      "repository/src/cli/watch-view.ts": "export {};\n",
      "runner/github-env": "EARLIER=1\n",
    },
    (directory) => {
      const repository = mergedRepository(directory);
      const runner = join(directory, "runner");
      const result = spawnSync(
        "/bin/bash",
        ["-e", "-o", "pipefail", "-c", run],
        {
          cwd: repository,
          env: {
            PATH: process.env["PATH"],
            GIT_CONFIG_GLOBAL: "/dev/null",
            RUNNER_TEMP: runner,
            GITHUB_ENV: join(runner, "github-env"),
          },
          encoding: "utf8",
          timeout: testMilliseconds(10_000),
        },
      );
      assert.equal(result.status, 0, result.stderr);
      return Promise.all([
        readFile(join(runner, "changed-paths"), "utf8"),
        readFile(join(runner, "github-env"), "utf8"),
      ]).then(([listed, environment]) => {
        assert.deepEqual(parseChangedPaths(listed), [
          "bin/old.ts",
          "src/cli/watch-view.ts",
          "src/new a.ts",
        ]);
        assert.equal(
          environment,
          `EARLIER=1\nCLOVING_CHANGED_PATHS=${join(runner, "changed-paths")}\n`,
        );
      });
    },
  );
});

await test("the README names the main-only list, each listed file and each trigger", async () => {
  const readme = await readFile("README.md", "utf8");
  const groups: unknown = JSON.parse(
    await readFile("quality/main-only-tests.json", "utf8"),
  );
  assert.ok(Array.isArray(groups));
  for (const name of [
    "quality/main-only-tests.json",
    "CLOVING_CHANGED_PATHS",
    "fetch-depth: 2",
  ])
    assert.ok(readme.includes(`\`${name}\``), name);
  for (const group of groups) {
    for (const field of ["files", "triggers"]) {
      const names: unknown = Reflect.get(Object(group), field);
      assert.ok(Array.isArray(names));
      for (const entry of names)
        assert.ok(readme.includes(`\`${String(entry)}\``), String(entry));
    }
  }
});
