import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { field, items } from "./self-host-fixture.ts";
import {
  job,
  releaseAttempt,
  releaseWorkflow,
  script,
  steps,
  tagged,
} from "./release-fixture.ts";

async function metadata(file: string): Promise<unknown> {
  const value: unknown = JSON.parse(
    await readFile(join(import.meta.dirname, "..", file), "utf8"),
  );
  return value;
}

await test("CLV-097 release metadata and both lock versions describe the public 1.0.0 package", async () => {
  const manifest = await metadata("package.json");
  const lock = await metadata("package-lock.json");
  assert.equal(field(manifest, "name"), "cloving");
  assert.equal(field(manifest, "version"), "1.0.0");
  assert.equal(field(manifest, "private"), undefined);
  assert.deepEqual(field(manifest, "repository"), {
    type: "git",
    url: "git+https://github.com/cloving-ai/cloving-ai.git",
  });
  assert.equal(
    field(manifest, "homepage"),
    "https://github.com/cloving-ai/cloving-ai#readme",
  );
  assert.deepEqual(field(manifest, "bugs"), {
    url: "https://github.com/cloving-ai/cloving-ai/issues",
  });
  assert.deepEqual(field(manifest, "engines"), {
    node: ">=26.9.0 <27",
    npm: ">=11.19.1 <12",
  });
  assert.deepEqual(field(manifest, "os"), ["darwin"]);
  assert.deepEqual(field(manifest, "cpu"), ["arm64"]);
  assert.equal(field(lock, "version"), "1.0.0");
  const root = field(field(lock, "packages"), "");
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
  ])
    assert.deepEqual(field(root, name), field(manifest, name), name);
});

await test("CLV-097 release leaves dependency pins, overrides and every resolved lock record unchanged", async () => {
  const manifest = await metadata("package.json");
  const packages = field(await metadata("package-lock.json"), "packages");
  assert.ok(packages && typeof packages === "object");
  const baseline = {
    dependencies: field(manifest, "dependencies"),
    devDependencies: field(manifest, "devDependencies"),
    overrides: field(manifest, "overrides"),
    packages: Object.fromEntries(
      Object.entries(packages).filter(([name]) => name !== ""),
    ),
  };
  assert.equal(
    createHash("sha256").update(JSON.stringify(baseline)).digest("hex"),
    "b1d3cee2c5ea4b2316dd2f2fc390cdf6a3bfc865351e197b40ecaae4b5a5e9e8",
  );
});

await test("CLV-097 CI checks every push, pull request and manual run with least privilege", async () => {
  const workflow = await releaseWorkflow();
  assert.deepEqual(field(workflow, "on"), {
    push: {},
    pull_request: {},
    workflow_dispatch: {},
  });
  assert.deepEqual(field(workflow, "permissions"), { contents: "read" });
  assert.equal(field(job(workflow, "quality"), "if"), undefined);
  assert.equal(field(job(workflow, "quality"), "permissions"), undefined);
  for (const name of ["quality", "publish"]) {
    assert.equal(field(job(workflow, name), "runs-on"), "macos-15");
    const checkout = steps(workflow, name).find((step) =>
      String(field(step, "uses")).startsWith("actions/checkout@"),
    );
    assert.deepEqual(field(checkout, "with"), {
      ref: "${{ github.sha }}",
      "persist-credentials": false,
    });
    const setup = steps(workflow, name).find((step) =>
      String(field(step, "uses")).startsWith("actions/setup-node@"),
    );
    assert.deepEqual(field(setup, "with"), {
      "node-version": "26.9.0",
      architecture: "arm64",
      "registry-url": "https://registry.npmjs.org",
      "package-manager-cache": false,
    });
    const actions = steps(workflow, name)
      .map((step) => field(step, "uses"))
      .filter((action) => action !== undefined);
    assert.equal(actions.length, 2);
    for (const action of actions) {
      assert.ok(typeof action === "string");
      assert.match(action, /^actions\/(?:checkout|setup-node)@[a-f0-9]{40}$/);
    }
    for (const step of steps(workflow, name)) {
      assert.equal(field(step, "continue-on-error"), undefined);
      assert.equal(field(step, "if"), undefined);
    }
  }
});

await test("CLV-097 quality qualifies the exact toolchain, completes the developer gate and verifies installed startup", async () => {
  const workflow = await releaseWorkflow();
  const commands = steps(workflow, "quality")
    .map((step) => field(step, "run"))
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
  assert.equal(field(job(workflow, "publish"), "needs"), "quality");
  assert.equal(
    field(job(workflow, "publish"), "if"),
    "${{ success() && needs.quality.result == 'success' && github.event_name == 'push' && github.ref_type == 'tag' && startsWith(github.ref, 'refs/tags/v') }}",
  );
  assert.deepEqual(field(job(workflow, "publish"), "permissions"), {
    contents: "write",
    "id-token": "write",
  });
  const commands = steps(workflow, "publish")
    .map((step) => field(step, "run"))
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
    field(field(job(workflow, "publish"), "env"), "NPM_CONFIG_REGISTRY"),
    "https://registry.npmjs.org",
  );
  assert.doesNotMatch(
    JSON.stringify(workflow),
    /NPM_TOKEN|NODE_AUTH_TOKEN|npm run check["\\]|test:concurrency/,
  );
  const release = steps(workflow, "publish").find(
    (step) => field(step, "id") === "github-release",
  );
  assert.deepEqual(field(release, "env"), { GH_TOKEN: "${{ github.token }}" });
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
    result.commands.map((entry) => items(entry).slice(0, 2)),
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
  const calls = result.commands.map((entry) => items(entry).slice(0, 2));
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
      result.commands.map((entry) => items(entry).slice(0, 2)),
      [["npm", "view"]],
    );
  }
});

await test("CLV-097 a failed npm publication never creates a GitHub release", async () => {
  const result = await releaseAttempt({ publishExit: 1 });
  assert.notEqual(result.statuses[0], 0);
  assert.deepEqual(
    result.commands.map((entry) => items(entry).slice(0, 2)),
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
    result.commands.filter((entry) => items(entry)[1] === "release").length,
    0,
  );
});
