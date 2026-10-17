import assert from "node:assert/strict";
import { test } from "node:test";
import {
  job,
  metadata,
  parseCommands,
  releaseAttempt,
  releaseWorkflow,
  script,
  steps,
  tagged,
} from "./release-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";

await test("CLV-097 release fixtures reject malformed workflow shapes at the JSON boundary", async () => {
  const workflow = await releaseWorkflow();
  for (const value of [
    null,
    [],
    {},
    { ...workflow, permissions: [] },
    {
      ...workflow,
      jobs: {
        ...workflow.jobs,
        quality: { ...workflow.jobs.quality, "runs-on": 15 },
      },
    },
    {
      ...workflow,
      jobs: {
        ...workflow.jobs,
        quality: { ...workflow.jobs.quality, "timeout-minutes": "60" },
      },
    },
    {
      ...workflow,
      jobs: {
        ...workflow.jobs,
        quality: { ...workflow.jobs.quality, steps: [{ run: 42 }] },
      },
    },
  ])
    await withFiles(
      { ".github/workflows/ci.yml": JSON.stringify(value) },
      async (directory) => {
        await assert.rejects(
          releaseWorkflow(directory),
          /Invalid release workflow/,
        );
      },
    );
});

await test("CLV-097 release fixtures validate command argument arrays", () => {
  assert.deepEqual(parseCommands('["npm","view"]\n\n["gh","api"]\n'), [
    ["npm", "view"],
    ["gh", "api"],
  ]);
  for (const value of [null, {}, "npm", [1], ["npm", null], ["gh", ["api"]]])
    assert.throws(
      () => parseCommands(JSON.stringify(value)),
      /Invalid release command/,
    );
});

await test("CLV-097 release fixtures reject malformed manifest and lock metadata", async () => {
  const { manifest, lock } = await metadata();
  for (const invalid of [
    null,
    [],
    { ...manifest, version: 100 },
    { ...manifest, engines: { node: 26, npm: "11" } },
    { ...manifest, dependencies: { workflow: 5 } },
    { ...manifest, repository: { type: true } },
  ])
    await withFiles(
      {
        "package.json": JSON.stringify(invalid),
        "package-lock.json": JSON.stringify(lock),
      },
      async (directory) => {
        await assert.rejects(metadata(directory), /Invalid release metadata/);
      },
    );
  for (const invalid of [
    null,
    [],
    { ...lock, version: 1 },
    { ...lock, packages: {} },
    { ...lock, packages: { "": { ...lock.packages[""], version: 100 } } },
  ])
    await withFiles(
      {
        "package.json": JSON.stringify(manifest),
        "package-lock.json": JSON.stringify(invalid),
      },
      async (directory) => {
        await assert.rejects(metadata(directory), /Invalid release metadata/);
      },
    );
});

await test("CLV-097 release metadata and both lock versions describe the public 1.0.0 package", async () => {
  const { manifest, lock } = await metadata();
  assert.equal(manifest.name, "cloving");
  assert.equal(manifest.version, "1.0.0");
  assert.equal(manifest.private, undefined);
  assert.deepEqual(manifest.repository, {
    type: "git",
    url: "git+https://github.com/cloving-ai/cloving-ai.git",
  });
  assert.equal(
    manifest.homepage,
    "https://github.com/cloving-ai/cloving-ai#readme",
  );
  assert.deepEqual(manifest.bugs, {
    url: "https://github.com/cloving-ai/cloving-ai/issues",
  });
  assert.deepEqual(manifest.engines, {
    node: ">=26.9.0 <27",
    npm: ">=11.19.1 <12",
  });
  assert.deepEqual(manifest.os, ["darwin"]);
  assert.deepEqual(manifest.cpu, ["arm64"]);
  assert.equal(lock.version, "1.0.0");
  const root = lock.packages[""];
  for (const name of [
    "name",
    "version",
    "license",
    "bin",
    "engines",
    "os",
    "cpu",
    "dependencies",
    "devDependencies",
  ] as const)
    assert.deepEqual(root[name], manifest[name], name);
});

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
  for (const name of ["quality", "publish"] as const) {
    assert.equal(job(workflow, name)["runs-on"], "macos-15");
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
      architecture: "arm64",
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
  assert.equal(job(workflow, "quality")["timeout-minutes"], 60);
  assert.deepEqual(job(workflow, "quality").env, {
    CLOVING_CHECK_TIME_FACTOR: "3",
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
  assert.match(qualification, /sw_vers -productVersion/);
  assert.match(qualification, /npm --version/);
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
  assert.equal(job(workflow, "publish").needs, "quality");
  assert.equal(
    job(workflow, "publish").if,
    "${{ success() && needs.quality.result == 'success' && github.event_name == 'push' && github.ref_type == 'tag' && startsWith(github.ref, 'refs/tags/v') }}",
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

await test("CLV-097 branches, pull requests, dispatches and failed, cancelled or skipped quality run no release commands", async () => {
  const contexts = [
    {
      ...tagged,
      github: {
        ...tagged.github,
        ref: "refs/heads/v1.0.0",
        ref_type: "branch",
      },
    },
    { ...tagged, github: { ...tagged.github, event_name: "pull_request" } },
    {
      ...tagged,
      github: { ...tagged.github, event_name: "workflow_dispatch" },
    },
    ...["failure", "cancelled", "skipped"].map((quality) => ({
      ...tagged,
      quality,
    })),
    { ...tagged, github: { ...tagged.github, ref: "refs/tags/release" } },
  ];
  for (const context of contexts)
    assert.deepEqual(await releaseAttempt({ context }), {
      statuses: [],
      commands: [],
    });
});

await test("CLV-097 a mismatching tag stops before registry, publication or release", async () => {
  const result = await releaseAttempt({
    context: {
      ...tagged,
      github: { ...tagged.github, ref: "refs/tags/v9.9.9", ref_name: "v9.9.9" },
    },
  });
  assert.notEqual(result.statuses[0], 0);
  assert.deepEqual(result.commands, []);
});

await test("CLV-097 a confirmed missing version publishes publicly before creating a verified-tag release", async () => {
  const result = await releaseAttempt();
  assert.deepEqual(result.statuses, [0]);
  assert.deepEqual(result.commands, [
    ["npm", "view", "cloving@1.0.0", "version", "--json"],
    ["npm", "publish", "--access", "public", "--ignore-scripts"],
    [
      "gh",
      "api",
      "--include",
      "repos/cloving-ai/cloving-ai/releases/tags/v1.0.0",
    ],
    [
      "gh",
      "release",
      "create",
      "v1.0.0",
      "--repo",
      "cloving-ai/cloving-ai",
      "--verify-tag",
      "--target",
      "a".repeat(40),
      "--generate-notes",
    ],
  ]);
});

await test("CLV-097 an existing npm version skips publish and repairs a missing GitHub release", async () => {
  const result = await releaseAttempt({ registry: '"1.0.0"', registryExit: 0 });
  assert.deepEqual(result.statuses, [0]);
  assert.deepEqual(
    result.commands.map((entry) => entry.slice(0, 2)),
    [
      ["npm", "view"],
      ["gh", "api"],
      ["gh", "release"],
    ],
  );
});

await test("CLV-097 retries publish only once and accept an existing release", async () => {
  const result = await releaseAttempt({ attempts: 2 });
  assert.deepEqual(result.statuses, [0, 0]);
  const calls = result.commands.map((entry) => entry.slice(0, 2));
  assert.equal(
    calls.filter((entry) => entry[0] === "npm" && entry[1] === "publish")
      .length,
    1,
  );
  assert.equal(
    calls.filter((entry) => entry[0] === "gh" && entry[1] === "release").length,
    1,
  );
  assert.deepEqual(calls.slice(-2), [
    ["npm", "view"],
    ["gh", "api"],
  ]);
});

await test("CLV-097 registry failures and malformed or unexpected responses fail closed", async () => {
  for (const [registry, registryExit] of [
    ['{"error":{"code":"E401"}}', 1],
    ['{"error":{"code":"E500"}}', 1],
    ["connection failed", 1],
    ['{"error":{"code":"E404"}}', 0],
    ['"0.3.20"', 0],
    ["", 0],
  ] as const) {
    const result = await releaseAttempt({ registry, registryExit });
    assert.notEqual(result.statuses[0], 0, registry);
    assert.deepEqual(
      result.commands.map((entry) => entry.slice(0, 2)),
      [["npm", "view"]],
    );
  }
});

await test("CLV-097 a failed npm publication never creates a GitHub release", async () => {
  const result = await releaseAttempt({ publishExit: 1 });
  assert.notEqual(result.statuses[0], 0);
  assert.deepEqual(
    result.commands.map((entry) => entry.slice(0, 2)),
    [
      ["npm", "view"],
      ["npm", "publish"],
    ],
  );
});

await test("CLV-097 GitHub errors other than a confirmed missing release fail closed", async () => {
  const result = await releaseAttempt({ releaseStatus: "403 Forbidden" });
  assert.notEqual(result.statuses[0], 0);
  assert.equal(
    result.commands.filter((entry) => entry[1] === "release").length,
    0,
  );
});
