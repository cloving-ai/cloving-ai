import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { test } from "node:test";
import {
  changedPathsRun,
  gateRun,
  job,
  metadata,
  releaseWorkflow,
  runs,
  script,
  steps,
} from "./release-fixture.ts";
import { testMilliseconds } from "./test-timing.ts";

const nodeVersions = {
  quality_macos: "26.9.0",
  quality_linux_node: "${{ matrix.node }}",
  publish: "26.9.0",
} as const;

await test("CI cancels the older runs of a branch or a pull request, and keeps every run of main and of a tag", async () => {
  const workflow = await releaseWorkflow();
  assert.deepEqual(workflow.concurrency, {
    group:
      "ci-${{ github.event_name }}-${{ (github.ref == 'refs/heads/main' || github.ref_type == 'tag') && github.run_id || github.ref }}",
    "cancel-in-progress": true,
  });
});

await test("CI runs every job of every event on hosted runners", async () => {
  const workflow = await releaseWorkflow();
  for (const [name, definition] of Object.entries(workflow.jobs)) {
    assert.doesNotMatch(
      JSON.stringify(definition),
      /self-hosted|cloving-ci|head\.repo/,
      name,
    );
  }
});

await test("CLV-266 job environments resolve before a runner is assigned", async () => {
  const workflow = await releaseWorkflow();
  for (const [name, definition] of Object.entries(workflow.jobs))
    assert.doesNotMatch(
      JSON.stringify(definition.env ?? {}),
      /\brunner\./,
      name,
    );
});

await test("CLV-097 CI checks main and version tag pushes, every pull request and manual run with least privilege", async () => {
  const workflow = await releaseWorkflow();
  assert.deepEqual(workflow.permissions, { contents: "read" });
  for (const name of ["quality_macos", "quality_linux_node"] as const)
    assert.equal(job(workflow, name).if, "${{ github.ref_type != 'tag' }}");
  assert.equal(job(workflow, "quality_macos").permissions, undefined);
  for (const [name, runner, architecture] of [
    ["quality_macos", "macos-15", "arm64"],
    [
      "quality_linux_node",
      "ubuntu-24.04",
      "${{ env.CLOVING_CI_ARCHITECTURE }}",
    ],
    ["publish", "macos-15", "arm64"],
  ] as const) {
    assert.equal(job(workflow, name)["runs-on"], runner);
    const checkout = steps(workflow, name).find((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    assert.deepEqual(checkout?.with, {
      ref: "${{ github.sha }}",
      ...(name === "publish" ? {} : { "fetch-depth": 2 }),
      "persist-credentials": false,
    });
    const setup = steps(workflow, name).find((step) =>
      step.uses?.startsWith("actions/setup-node@"),
    );
    assert.deepEqual(setup?.with, {
      "node-version": nodeVersions[name],
      architecture,
      "registry-url": "https://registry.npmjs.org",
      "package-manager-cache": false,
    });
    const actions = steps(workflow, name)
      .map((step) => step.uses)
      .filter((action) => action !== undefined);
    assert.equal(actions.length, name === "publish" ? 2 : 3);
    for (const action of actions) {
      assert.ok(typeof action === "string");
      assert.match(
        action,
        /^actions\/(?:checkout|setup-node|upload-artifact)@[a-f0-9]{40}$/,
      );
    }
  }
});

await test("CLV-266 only the first full shard and the macOS platform job run setup checks", async () => {
  const workflow = await releaseWorkflow();
  for (const name of [
    "quality_macos",
    "quality_linux_node",
    "publish",
  ] as const) {
    for (const step of steps(workflow, name)) {
      assert.equal(step["continue-on-error"], undefined);
      assert.equal(
        step["timeout-minutes"],
        step.id === "prepare-shells" ? 6 : undefined,
      );
      const conditions = [
        [
          step.run === "npm run check:setup" && name === "quality_macos",
          "${{ matrix.shard == '1' || matrix.shard == 'platform' }}",
        ],
        [
          step.run === "npm run check:setup" && name !== "publish",
          "${{ matrix.shard == '1' }}",
        ],
        [
          step.uses?.startsWith("actions/upload-artifact@") === true ||
            step.id === "changed-paths",
          "${{ github.event_name == 'pull_request' }}",
        ],
      ] as const;
      assert.equal(step.if, conditions.find(([applies]) => applies)?.[1]);
    }
  }
});

await test("CLV-097 quality qualifies the exact toolchain and completes the developer gate", async () => {
  const workflow = await releaseWorkflow();
  assert.equal(
    job(workflow, "quality_linux_node").if,
    "${{ github.ref_type != 'tag' }}",
  );
  assert.equal(job(workflow, "quality_linux_node").permissions, undefined);
  assert.equal(job(workflow, "quality_linux_node")["timeout-minutes"], 30);
  assert.deepEqual(job(workflow, "quality_linux_node").env, {
    CLOVING_CHECK_TIME_FACTOR: "3",
    CLOVING_TEST_CONCURRENCY: "4",
    CLOVING_TEST_SHARD:
      "${{ format('{0}/{1}', matrix.shard, github.event_name == 'pull_request' && '6' || '3') }}",
    CLOVING_CI_ARCHITECTURE: "x64",
    NODE_OPTIONS: "--max-old-space-size=4096",
  });
  assert.equal(job(workflow, "quality_macos")["timeout-minutes"], 30);
  assert.deepEqual(job(workflow, "quality_macos").env, {
    CLOVING_CHECK_TIME_FACTOR: "3",
    CLOVING_TEST_CONCURRENCY: "3",
    CLOVING_TEST_SET:
      "${{ matrix.shard == 'platform' && 'platform' || 'all' }}",
    CLOVING_TEST_SHARD:
      "${{ matrix.shard == 'platform' && '1/1' || format('{0}/3', matrix.shard) }}",
    CLOVING_CI_MACOS_VERSION: "15.*",
    NODE_OPTIONS: "--max-old-space-size=4096",
  });
  const commands = runs(workflow, "quality_macos");
  assert.deepEqual(commands.slice(0, 1), [
    "npm install --global npm@11.19.1 --ignore-scripts",
  ]);
  const qualification = commands[1];
  assert.ok(typeof qualification === "string");
  assert.match(qualification, /process\.version.*v26\.9\.0/);
  assert.match(qualification, /process\.platform.*darwin/);
  assert.match(qualification, /process\.arch.*arm64/);
  assert.match(
    qualification,
    /case "\$\(sw_vers -productVersion\)" in \$CLOVING_CI_MACOS_VERSION\)/,
  );
  assert.match(qualification, /npm --version/);
  assert.deepEqual(commands.slice(2), [
    "npm ci --ignore-scripts",
    "npm run check:setup",
    changedPathsRun,
    gateRun,
  ]);
});

await test("CLV-266 Linux shards qualify the selected toolchain before the gate", async () => {
  const workflow = await releaseWorkflow();
  const commands = runs(workflow, "quality_macos");
  const linuxCommands = runs(workflow, "quality_linux_node");
  assert.equal(linuxCommands[0], commands[0]);
  const linuxQualification = linuxCommands[1];
  assert.ok(typeof linuxQualification === "string");
  assert.match(
    linuxQualification,
    /assert\.equal\(process\.version, "v\$\{\{ matrix\.node \}\}"\)/,
  );
  assert.match(linuxQualification, /process\.platform.*linux/);
  assert.match(
    linuxQualification,
    /process\.arch, process\.env\.CLOVING_CI_ARCHITECTURE/,
  );
  assert.match(linuxQualification, /npm --version/);
  assert.deepEqual(linuxCommands.slice(2, 3), commands.slice(2, 3));
  assert.deepEqual(linuxCommands.slice(4), commands.slice(3));
});

await test("CLV-097 Linux CI qualifies the lowest Node version of each engine range on main and tags, and a pull request runs the newest of them in six shards", async () => {
  const workflow = await releaseWorkflow();
  const { manifest } = await metadata();
  const lowest = (manifest.devEngines.runtime["version"] ?? "")
    .split(" || ")
    .map((range) => /^>=(\d+\.\d+\.\d+) <\d+$/.exec(range)?.[1]);
  assert.deepEqual(lowest, ["24.22.1", "26.9.0"]);
  const newest = lowest.at(-1);
  assert.equal(newest, "26.9.0");
  assert.deepEqual(job(workflow, "quality_linux_node").strategy, {
    "fail-fast": false,
    matrix: {
      node: `\${{ fromJSON(github.event_name == 'pull_request' && '${JSON.stringify([newest])}' || '${JSON.stringify(lowest)}') }}`,
      shard: `\${{ fromJSON(github.event_name == 'pull_request' && '${JSON.stringify(["1", "2", "3", "4", "5", "6"])}' || '${JSON.stringify(["1", "2", "3"])}') }}`,
    },
  });
  assert.equal(job(workflow, "publish").strategy, undefined);
});

await test("CLV-097 the quality_linux check passes only when every Linux Node version passes", async () => {
  const workflow = await releaseWorkflow();
  const aggregate = job(workflow, "quality_linux");
  assert.equal(aggregate["runs-on"], "ubuntu-24.04");
  assert.equal(aggregate["timeout-minutes"], 5);
  assert.deepEqual(aggregate.needs, ["quality_linux_node", "coverage"]);
  assert.equal(aggregate.if, "${{ always() && github.ref_type != 'tag' }}");
  assert.equal(aggregate.permissions, undefined);
  assert.equal(aggregate.steps.length, 1);
  const [check] = aggregate.steps;
  assert.deepEqual(check?.env, {
    SHARD_RESULT: "${{ needs.quality_linux_node.result }}",
    COVERAGE_RESULT: "${{ needs.coverage.result }}",
    EVENT_NAME: "${{ github.event_name }}",
  });
  const run = check.run;
  assert.ok(typeof run === "string");
  assert.equal(job(workflow, "quality").steps[0]?.run, run);
  for (const [shard, coverage, event, status] of [
    ["success", "success", "pull_request", 0],
    ["failure", "success", "pull_request", 1],
    ["cancelled", "success", "pull_request", 1],
    ["skipped", "success", "pull_request", 1],
    ["", "success", "pull_request", 1],
    ["success", "skipped", "pull_request", 1],
    ["success", "failure", "pull_request", 1],
    ["success", "skipped", "push", 0],
    ["success", "failure", "push", 1],
    ["failure", "skipped", "push", 1],
  ] as const) {
    const outcome: SpawnSyncReturns<string> = spawnSync(
      "/bin/bash",
      ["-e", "-o", "pipefail", "-c", run],
      {
        env: {
          SHARD_RESULT: shard,
          COVERAGE_RESULT: coverage,
          EVENT_NAME: event,
        },
        encoding: "utf8",
        timeout: testMilliseconds(10000),
      },
    );
    assert.equal(outcome.status, status, `${shard} ${coverage} ${event}`);
  }
});

await test("CLV-097 publish uses same-revision successful quality and only version-tag pushes", async () => {
  const workflow = await releaseWorkflow();
  assert.deepEqual(job(workflow, "publish").needs, ["release_check"]);
  assert.equal(
    job(workflow, "publish").if,
    "${{ success() && needs.release_check.result == 'success' && github.event_name == 'push' && github.ref_type == 'tag' && startsWith(github.ref, 'refs/tags/v') }}",
  );
  assert.deepEqual(job(workflow, "publish").permissions, {
    contents: "write",
    "id-token": "write",
  });
  const commands = runs(workflow, "publish");
  assert.equal(commands[0], script(workflow, "validate-tag"));
  assert.deepEqual(commands.slice(1, 4), [
    "npm install --global npm@11.19.1 --ignore-scripts",
    "npm ci --ignore-scripts",
    "npm run build",
  ]);
  assert.deepEqual(commands.slice(4), [
    script(workflow, "publish-package"),
    script(workflow, "github-release"),
  ]);
  assert.equal(
    job(workflow, "publish").env?.["NPM_CONFIG_REGISTRY"],
    "https://registry.npmjs.org",
  );
  assert.equal(
    job(workflow, "publish").env?.["CLOVING_CHECK_TIME_FACTOR"],
    undefined,
  );
  for (const step of steps(workflow, "publish"))
    assert.equal(step.env?.["CLOVING_CHECK_TIME_FACTOR"], undefined);
  assert.doesNotMatch(
    JSON.stringify(workflow),
    /NPM_TOKEN|NODE_AUTH_TOKEN|npm run check["\\]|test:concurrency/,
  );
  const release = steps(workflow, "publish").find(
    (step) => step.id === "github-release",
  );
  assert.deepEqual(release?.env, { GH_TOKEN: "${{ github.token }}" });
});

await test("CLV-266 every shard exports coverage, shows the start and end of each test file in the job log, and both required checks need the final job", async () => {
  const workflow = await releaseWorkflow();
  for (const name of ["quality_macos", "quality_linux_node"] as const) {
    const gate = steps(workflow, name).find((step) => step.run === gateRun);
    const directory = "${{ runner.temp }}/cloving-coverage/shard";
    assert.deepEqual(gate?.env, {
      CLOVING_TEST_PROGRESS_FILE:
        "${{ runner.temp }}/cloving-test-progress.log",
      CLOVING_COVERAGE_DIRECTORY: directory,
      CLOVING_TEST_COVERAGE:
        "${{ github.event_name == 'pull_request' && 'on' || 'off' }}",
    });
    const upload = steps(workflow, name).find((step) =>
      step.uses?.startsWith("actions/upload-artifact@"),
    );
    assert.equal(upload?.if, "${{ github.event_name == 'pull_request' }}");
    assert.equal(upload.with?.["path"], directory);
    assert.equal(upload.with["if-no-files-found"], "error");
    assert.equal(upload.with["overwrite"], true);
    assert.match(String(upload.with["name"]), /\$\{\{ matrix.shard \}\}/);
  }
  const aggregate = job(workflow, "quality");
  assert.deepEqual(aggregate.needs, ["quality_macos", "coverage"]);
  assert.equal(aggregate.if, "${{ always() && github.ref_type != 'tag' }}");
  assert.equal(
    aggregate.steps[0]?.env?.["SHARD_RESULT"],
    "${{ needs.quality_macos.result }}",
  );
});

await test("CLV-266 shard jobs run test files only through the gate partition", async () => {
  const workflow = await releaseWorkflow();
  for (const name of ["quality_macos", "quality_linux_node"] as const)
    assert.deepEqual(
      steps(workflow, name).filter((step) =>
        step.run?.startsWith("node --test "),
      ),
      [],
    );
});
