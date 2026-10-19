import assert from "node:assert/strict";
import { test } from "node:test";
import {
  metadata,
  packageVersion,
  parseCommands,
  releaseAttempt,
  releaseWorkflow,
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
    { ...manifest, os: ["darwin", 1] },
    { ...manifest, cpu: ["arm64", false] },
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

await test("CLV-101 release metadata and both lock versions describe the public package", async () => {
  const { manifest, lock } = await metadata();
  assert.equal(manifest.name, "cloving");
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
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
  assert.deepEqual(manifest.os, ["darwin", "linux"]);
  assert.deepEqual(manifest.cpu, ["arm64", "x64"]);
  assert.equal(lock.version, manifest.version);
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

await test("CLV-097 branches, pull requests, dispatches and failed, cancelled or skipped quality run no release commands", async () => {
  const contexts = [
    {
      ...tagged,
      github: {
        ...tagged.github,
        ref: `refs/heads/v${packageVersion}`,
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
    ...["failure", "cancelled", "skipped"].map((quality_linux) => ({
      ...tagged,
      quality_linux,
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
  const tag = `${tagged.github.ref_name}-mismatch`;
  const result = await releaseAttempt({
    context: {
      ...tagged,
      github: { ...tagged.github, ref: `refs/tags/${tag}`, ref_name: tag },
    },
  });
  assert.notEqual(result.statuses[0], 0);
  assert.deepEqual(result.commands, []);
});

await test("CLV-097 a confirmed missing version publishes publicly before creating a verified-tag release", async () => {
  const result = await releaseAttempt();
  assert.deepEqual(result.statuses, [0]);
  assert.deepEqual(result.commands, [
    ["npm", "view", `cloving@${packageVersion}`, "version", "--json"],
    ["npm", "publish", "--access", "public", "--ignore-scripts"],
    [
      "gh",
      "api",
      "--include",
      `repos/cloving-ai/cloving-ai/releases/tags/v${packageVersion}`,
    ],
    [
      "gh",
      "release",
      "create",
      `v${packageVersion}`,
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
  const result = await releaseAttempt({
    registry: JSON.stringify(packageVersion),
    registryExit: 0,
  });
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
    [JSON.stringify(`${packageVersion}-unexpected`), 0],
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
