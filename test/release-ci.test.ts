import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { job, releaseWorkflow, script, steps } from "./release-fixture.ts";

const sameRepositoryPullRequest =
  "github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository";

function localOr(local: string, hosted: string): string {
  return `\${{ ${sameRepositoryPullRequest} && ${local} || ${hosted} }}`;
}

await test("CLV-097 CI checks every push, pull request and manual run with least privilege", async () => {
  const workflow = await releaseWorkflow();
  assert.deepEqual(workflow.on, {
    push: {},
    pull_request: {},
    workflow_dispatch: {},
  });
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(job(workflow, "quality").if, undefined);
  assert.equal(job(workflow, "quality").permissions, undefined);
  for (const [name, runner, architecture] of [
    [
      "quality",
      localOr(
        `fromJSON('["self-hosted","macOS","ARM64","cloving-ci"]')`,
        "'macos-15'",
      ),
      "arm64",
    ],
    [
      "quality_linux",
      localOr(
        `fromJSON('["self-hosted","Linux","ARM64","cloving-ci"]')`,
        "'ubuntu-24.04'",
      ),
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
      "persist-credentials": false,
    });
    const setup = steps(workflow, name).find((step) =>
      step.uses?.startsWith("actions/setup-node@"),
    );
    assert.deepEqual(setup?.with, {
      "node-version": "26.9.0",
      architecture,
      "registry-url": "https://registry.npmjs.org",
      "package-manager-cache": false,
    });
    const actions = steps(workflow, name)
      .map((step) => step.uses)
      .filter((action) => action !== undefined);
    assert.equal(actions.length, 2);
    for (const action of actions) {
      assert.ok(typeof action === "string");
      assert.match(action, /^actions\/(?:checkout|setup-node)@[a-f0-9]{40}$/);
    }
    for (const step of steps(workflow, name)) {
      assert.equal(step["continue-on-error"], undefined);
      assert.equal(step.if, undefined);
    }
  }
});

await test("CLV-097 quality qualifies the exact toolchain, completes the developer gate and verifies installed startup", async () => {
  const workflow = await releaseWorkflow();
  assert.equal(job(workflow, "quality_linux").if, undefined);
  assert.equal(job(workflow, "quality_linux").permissions, undefined);
  assert.equal(job(workflow, "quality_linux")["timeout-minutes"], 60);
  assert.deepEqual(job(workflow, "quality_linux").env, {
    CLOVING_CHECK_TIME_FACTOR: "3",
    CLOVING_TEST_CONCURRENCY: localOr("'8'", "'4'"),
    CLOVING_CI_ARCHITECTURE: localOr("'arm64'", "'x64'"),
  });
  assert.equal(job(workflow, "quality")["timeout-minutes"], 60);
  assert.deepEqual(job(workflow, "quality").env, {
    CLOVING_CHECK_TIME_FACTOR: "3",
    CLOVING_TEST_CONCURRENCY: localOr("'8'", "'3'"),
    CLOVING_CI_MACOS_VERSION: localOr("'*'", "'15.*'"),
  });
  const commands = steps(workflow, "quality")
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
  const linuxCommands = steps(workflow, "quality_linux")
    .map((step) => step.run)
    .filter((run) => run !== undefined);
  assert.equal(linuxCommands[0], commands[0]);
  const linuxQualification = linuxCommands[1];
  assert.ok(typeof linuxQualification === "string");
  assert.match(linuxQualification, /process\.version.*v26\.9\.0/);
  assert.match(linuxQualification, /process\.platform.*linux/);
  assert.match(
    linuxQualification,
    /process\.arch, process\.env\.CLOVING_CI_ARCHITECTURE/,
  );
  assert.match(linuxQualification, /npm --version/);
  assert.deepEqual(linuxCommands.slice(2, 3), commands.slice(2, 3));
  assert.deepEqual(linuxCommands.slice(4), commands.slice(3));
  assert.deepEqual(commands.slice(2), [
    "npm ci --ignore-scripts",
    "npm run check:setup",
    "npm run check:quality",
    "npm run build",
    "node --test test/packed-install.test.ts",
  ]);
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

await test("CLV-208 Linux CI prepares zsh before setup and skips sudo when installed", async () => {
  const workflow = await releaseWorkflow();
  const linuxSteps = steps(workflow, "quality_linux");
  const prepare = linuxSteps.findIndex((step) => step.id === "prepare-shells");
  const setup = linuxSteps.findIndex(
    (step) => step.run === "npm run check:setup",
  );
  assert.ok(prepare >= 0 && prepare < setup, "Prepare zsh before setup");
  const run = linuxSteps[prepare]?.run;
  assert.ok(typeof run === "string");
  const fixture = `
test() {
  [[ "$*" == "-x /bin/zsh" ]] || exit 90
  return "$ZSH_STATUS"
}
sudo() {
  printf '%s\\n' "$*"
  if [[ "$*" == "apt-get update" ]]; then return "$UPDATE_STATUS"; fi
}
`;
  const command = fixture + run;
  for (const [zshStatus, updateStatus, status, output] of [
    ["0", "0", 0, ""],
    ["1", "0", 0, "apt-get update\napt-get install -y zsh\n"],
    ["1", "9", 9, "apt-get update\n"],
  ] as const) {
    const result = spawnSync(
      "/bin/bash",
      ["-e", "-o", "pipefail", "-c", command],
      {
        env: { ZSH_STATUS: zshStatus, UPDATE_STATUS: updateStatus },
        encoding: "utf8",
        timeout: 10000,
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, status, result.stderr);
    assert.equal(result.stdout, output);
  }
});
