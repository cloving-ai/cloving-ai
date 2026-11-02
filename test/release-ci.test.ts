import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { test } from "node:test";
import {
  job,
  metadata,
  releaseWorkflow,
  script,
  steps,
} from "./release-fixture.ts";
import { testMilliseconds } from "./test-timing.ts";

const localPullRequest =
  "github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository";
const macosRunner = `\${{ ${localPullRequest} && fromJSON('["self-hosted","macOS","ARM64","cloving-ci"]') || 'macos-15' }}`;
const linuxRunner = `\${{ ${localPullRequest} && fromJSON('["self-hosted","Linux","ARM64","cloving-ci"]') || 'ubuntu-24.04' }}`;

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

await test("CLV-175 CI uses 12 local workers and keeps hosted worker counts", async () => {
  const workflow = await releaseWorkflow();
  for (const [name, hostedWorkers] of [
    ["quality_macos", "3"],
    ["quality_linux_node", "4"],
  ] as const)
    assert.equal(
      job(workflow, name).env?.["CLOVING_TEST_CONCURRENCY"],
      `\${{ ${localPullRequest} && '12' || '${hostedWorkers}' }}`,
    );
});

await test("CI keeps coverage, required checks and release on hosted runners", async () => {
  const workflow = await releaseWorkflow();
  for (const name of [
    "coverage",
    "quality",
    "quality_linux",
    "publish",
  ] as const) {
    const definition = job(workflow, name);
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
  assert.deepEqual(workflow.on, {
    push: { branches: ["main"], tags: ["v*"] },
    pull_request: {},
    workflow_dispatch: {},
  });
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(job(workflow, "quality_macos").if, undefined);
  assert.equal(job(workflow, "quality_macos").permissions, undefined);
  for (const [name, runner, architecture] of [
    ["quality_macos", macosRunner, "arm64"],
    ["quality_linux_node", linuxRunner, "${{ env.CLOVING_CI_ARCHITECTURE }}"],
    ["publish", "macos-15", "arm64"],
  ] as const) {
    assert.equal(job(workflow, name)["runs-on"], runner);
    const checkout = steps(workflow, name).find((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    assert.deepEqual(checkout?.with, {
      ref: "${{ github.sha }}",
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

await test("CLV-266 only shard 1 runs setup checks and the gate prepares test builds", async () => {
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
        step.id === "prepare-shells" ? 3 : undefined,
      );
      const conditional = step.run === "npm run check:setup";
      assert.equal(
        step.if,
        conditional && name !== "publish"
          ? "${{ matrix.shard == '1' }}"
          : undefined,
      );
    }
  }
});

await test("CLV-097 quality qualifies the exact toolchain and completes the developer gate", async () => {
  const workflow = await releaseWorkflow();
  assert.equal(job(workflow, "quality_linux_node").if, undefined);
  assert.equal(job(workflow, "quality_linux_node").permissions, undefined);
  assert.equal(job(workflow, "quality_linux_node")["timeout-minutes"], 30);
  assert.deepEqual(job(workflow, "quality_linux_node").env, {
    CLOVING_CHECK_TIME_FACTOR: "3",
    CLOVING_TEST_CONCURRENCY: `\${{ ${localPullRequest} && '12' || '4' }}`,
    CLOVING_TEST_SHARD: "${{ matrix.shard }}/3",
    CLOVING_CI_ARCHITECTURE: `\${{ ${localPullRequest} && 'arm64' || 'x64' }}`,
    NODE_OPTIONS: "--max-old-space-size=4096",
  });
  assert.equal(job(workflow, "quality_macos")["timeout-minutes"], 30);
  assert.deepEqual(job(workflow, "quality_macos").env, {
    CLOVING_CHECK_TIME_FACTOR: "3",
    CLOVING_TEST_CONCURRENCY: `\${{ ${localPullRequest} && '12' || '3' }}`,
    CLOVING_TEST_SHARD: "${{ matrix.shard }}/3",
    CLOVING_CI_MACOS_VERSION: `\${{ ${localPullRequest} && '*' || '15.*' }}`,
    NODE_OPTIONS: "--max-old-space-size=4096",
  });
  const commands = steps(workflow, "quality_macos")
    .map((step) => step.run)
    .filter((run) => run !== undefined);
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
    "npm run check:quality",
  ]);
});

await test("CLV-266 Linux shards qualify the selected toolchain before the gate", async () => {
  const workflow = await releaseWorkflow();
  const commands = steps(workflow, "quality_macos")
    .map((step) => step.run)
    .filter((run) => run !== undefined);
  const linuxCommands = steps(workflow, "quality_linux_node")
    .map((step) => step.run)
    .filter((run) => run !== undefined);
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

await test("CLV-097 Linux CI qualifies the lowest Node version of each engine range", async () => {
  const workflow = await releaseWorkflow();
  const { manifest } = await metadata();
  const lowest = (manifest.engines["node"] ?? "")
    .split(" || ")
    .map((range) => /^>=(\d+\.\d+\.\d+) <\d+$/.exec(range)?.[1]);
  assert.deepEqual(lowest, ["24.22.1", "26.9.0"]);
  assert.deepEqual(job(workflow, "quality_linux_node").strategy, {
    "fail-fast": false,
    matrix: { node: lowest, shard: ["1", "2", "3"] },
  });
  assert.deepEqual(job(workflow, "quality_macos").strategy, {
    "fail-fast": false,
    matrix: { shard: ["1", "2", "3"] },
  });
  assert.equal(job(workflow, "publish").strategy, undefined);
});

await test("CLV-097 the quality_linux check passes only when every Linux Node version passes", async () => {
  const workflow = await releaseWorkflow();
  const aggregate = job(workflow, "quality_linux");
  assert.equal(aggregate["runs-on"], "ubuntu-24.04");
  assert.equal(aggregate["timeout-minutes"], 5);
  assert.deepEqual(aggregate.needs, ["quality_linux_node", "coverage"]);
  assert.equal(aggregate.if, "${{ always() }}");
  assert.equal(aggregate.permissions, undefined);
  assert.equal(aggregate.steps.length, 1);
  const [check] = aggregate.steps;
  assert.deepEqual(check?.env, {
    SHARD_RESULT: "${{ needs.quality_linux_node.result }}",
    COVERAGE_RESULT: "${{ needs.coverage.result }}",
  });
  const run = check.run;
  assert.ok(typeof run === "string");
  for (const [result, status] of [
    ["success", 0],
    ["failure", 1],
    ["cancelled", 1],
    ["skipped", 1],
    ["", 1],
  ] as const) {
    const outcome: SpawnSyncReturns<string> = spawnSync(
      "/bin/bash",
      ["-e", "-o", "pipefail", "-c", run],
      {
        env: { SHARD_RESULT: result, COVERAGE_RESULT: "success" },
        encoding: "utf8",
        timeout: testMilliseconds(10000),
      },
    );
    assert.equal(outcome.status, status, result);
  }
});

await test("CLV-097 publish uses same-revision successful quality and only version-tag pushes", async () => {
  const workflow = await releaseWorkflow();
  assert.deepEqual(job(workflow, "publish").needs, [
    "quality",
    "quality_linux",
  ]);
  assert.equal(
    job(workflow, "publish").if,
    "${{ success() && needs.quality.result == 'success' && needs.quality_linux.result == 'success' && github.event_name == 'push' && github.ref_type == 'tag' && startsWith(github.ref, 'refs/tags/v') }}",
  );
  assert.deepEqual(job(workflow, "publish").permissions, {
    contents: "write",
    "id-token": "write",
  });
  const commands = steps(workflow, "publish")
    .map((step) => step.run)
    .filter((run) => run !== undefined);
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

await test("CLV-266 coverage joins all nine shard artifacts before the required checks pass", async () => {
  const workflow = await releaseWorkflow();
  const coverage = job(workflow, "coverage");
  assert.deepEqual(coverage.needs, ["quality_macos", "quality_linux_node"]);
  assert.equal(coverage["runs-on"], "ubuntu-24.04");
  assert.equal(coverage["timeout-minutes"], 10);
  assert.equal(coverage.if, undefined);
  const download = coverage.steps.find((step) =>
    step.uses?.startsWith("actions/download-artifact@"),
  );
  assert.match(
    download?.uses ?? "",
    /^actions\/download-artifact@[a-f0-9]{40}$/,
  );
  assert.deepEqual(download?.with, {
    pattern: "coverage-*",
    path: "${{ runner.temp }}/cloving-coverage",
  });
  const command = coverage.steps.find((step) =>
    step.run?.startsWith("node tools/check-shard-coverage.ts"),
  )?.run;
  assert.ok(command);
  for (const platform of ["macos-26.9.0", "linux-24.22.1", "linux-26.9.0"])
    for (const shard of ["1", "2", "3"])
      assert.ok(command.includes(`coverage-${platform}-${shard}`));
});

await test("CLV-266 every shard exports coverage and both required checks need the final job", async () => {
  const workflow = await releaseWorkflow();
  for (const name of ["quality_macos", "quality_linux_node"] as const) {
    const gate = steps(workflow, name).find(
      (step) => step.run === "npm run check:quality",
    );
    const directory = "${{ runner.temp }}/cloving-coverage/shard";
    assert.deepEqual(gate?.env, { CLOVING_COVERAGE_DIRECTORY: directory });
    const upload = steps(workflow, name).find((step) =>
      step.uses?.startsWith("actions/upload-artifact@"),
    );
    assert.equal(upload?.with?.["path"], directory);
    assert.equal(upload.with["if-no-files-found"], "error");
    assert.equal(upload.with["overwrite"], true);
    assert.match(String(upload.with["name"]), /\$\{\{ matrix.shard \}\}/);
  }
  const aggregate = job(workflow, "quality");
  assert.deepEqual(aggregate.needs, ["quality_macos", "coverage"]);
  assert.equal(aggregate.if, "${{ always() }}");
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
