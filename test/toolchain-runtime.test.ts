import assert from "node:assert/strict";
import { mkdir, readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { withFiles } from "./quality/files-fixture.ts";
import { observedToolchain, qualifiedToolchain } from "../src/cli/toolchain.ts";
import { admitWorkflow } from "../src/workflow-admission.ts";

const root = join(import.meta.dirname, "..");

await test("CLV-097 workflow admission accepts each Node version of the engine range", async () => {
  const observed = await observedToolchain(root);
  const workflowId = "workflow//./workflows/probe//probe";
  const registration = {
    name: "probe",
    workflowId,
    steps: [],
    capabilities: [],
    resources: [],
  };
  const admission = async (node: string) => {
    const toolchain = { ...observed, node };
    return admitWorkflow(registration, {
      compiled: {
        manifest: {
          workflows: { "probe.js": { probe: { workflowId } } },
          steps: {},
        },
        artifacts: { "flow.mjs": "a".repeat(64) },
        resources: {},
        toolchain,
      },
      policy: {
        toolchain: await qualifiedToolchain(toolchain, root),
        capabilities: [],
      },
    });
  };
  for (const node of ["v24.22.1", "v24.23.0", "v26.9.0", "v26.12.1"])
    assert.equal((await admission(node)).kind, "admitted", node);
  for (const node of [
    "v24.22.0",
    "v24.4.0",
    "v25.9.0",
    "v26.8.9",
    "v27.0.0",
    "v26.9",
    "26.9.0",
    "v>=26.9.0 <27",
    "",
  ])
    assert.deepEqual(
      await admission(node),
      { kind: "rejected", reason: "incompatible-toolchain", detail: "node" },
      node,
    );
});

async function field(file: string, path: readonly string[]): Promise<unknown> {
  const document: unknown = JSON.parse(
    await readFile(join(root, file), "utf8"),
  );
  return path.reduce<unknown>(
    (value, name) => Reflect.get(Object(value), name),
    document,
  );
}

await test("CLV-055 the qualified toolchain reads the SDK version from the runtime dependencies", async () => {
  const declared = await field("package.json", ["dependencies", "workflow"]);
  assert.match(String(declared), /^\d+\.\d+\.\d+$/);
  assert.equal(
    await field("package.json", ["devDependencies", "workflow"]),
    undefined,
  );
  const entry = ["packages", "node_modules/workflow"];
  assert.equal(
    await field("package-lock.json", [...entry, "version"]),
    declared,
  );
  assert.equal(await field("package-lock.json", [...entry, "dev"]), undefined);
  const qualified = await qualifiedToolchain(
    await observedToolchain(root),
    root,
  );
  assert.equal(qualified.sdk, `workflow@${String(declared)}`);
  assert.equal(
    qualified.builder,
    `@workflow/builders@${String(await field("package.json", ["dependencies", "@workflow/builders"]))}`,
  );
});

await test("CLV-096 the builder pin is a runtime dependency in manifest and lock", async () => {
  assert.equal(
    await field("package.json", ["dependencies", "@workflow/builders"]),
    "5.0.2",
  );
  assert.equal(
    await field("package.json", ["devDependencies", "@workflow/builders"]),
    undefined,
  );
  assert.equal(
    await field("package-lock.json", [
      "packages",
      "",
      "dependencies",
      "@workflow/builders",
    ]),
    "5.0.2",
  );
  assert.equal(
    await field("package-lock.json", [
      "packages",
      "node_modules/@workflow/builders",
      "dev",
    ]),
    undefined,
  );
});

await test("CLV-096 observes dependencies using package resolution across nested and hoisted layouts", async () => {
  const metadata = (name: string, version: string) =>
    JSON.stringify({
      name,
      version,
      main: "index.js",
      exports: "./index.js",
      dependencies: { "@workflow/world-local": "9.8.7" },
    });
  await withFiles(
    {
      "package-lock.json": "{}",
      "node_modules/workflow/package.json": metadata("workflow", "5.1.0"),
      "node_modules/workflow/index.js": "",
      "node_modules/@workflow/builders/package.json": metadata(
        "@workflow/builders",
        "5.0.2",
      ),
      "node_modules/@workflow/builders/index.js": "",
      "node_modules/@workflow/core/package.json": metadata(
        "@workflow/core",
        "5.1.0",
      ),
      "node_modules/@workflow/core/index.js": "",
      "node_modules/@workflow/core/node_modules/@workflow/world-local/package.json":
        metadata("@workflow/world-local", "9.8.7"),
      "node_modules/@workflow/core/node_modules/@workflow/world-local/index.js":
        "",
      "node_modules/cloving/dist/src/cli/entry.js": "",
    },
    async (directory) => {
      const start = join(directory, "node_modules/cloving/dist/src/cli");
      const observed = await observedToolchain(start);
      assert.equal(observed.sdk, "workflow@5.1.0");
      assert.equal(observed.builder, "@workflow/builders@5.0.2");
      assert.equal(observed.world, "@workflow/world-local@9.8.7");
      assert.match(observed.dependencies, /^[a-f0-9]{64}$/);
      assert.equal(
        (await qualifiedToolchain(observed, start)).world,
        observed.world,
      );
    },
  );
});

await test("CLV-096 resolves import-only runtime packages without loading their code", async () => {
  await withFiles(
    {
      "node_modules/workflow/package.json": JSON.stringify({
        name: "workflow",
        version: "5.1.0",
        exports: { ".": { import: "./index.js" } },
      }),
      "node_modules/workflow/index.js":
        'throw new Error("must not execute metadata target");',
    },
    async (directory) => {
      assert.equal((await observedToolchain(directory)).sdk, "workflow@5.1.0");
    },
  );
});

await test("CLV-096 observes transitive dependencies through generated host package links", async () => {
  const metadata = (name: string, version: string) =>
    JSON.stringify({
      name,
      version,
      main: "index.js",
      dependencies: { "@workflow/world-local": "9.8.7" },
    });
  await withFiles(
    {
      "installed/node_modules/workflow/package.json": metadata(
        "workflow",
        "5.1.0",
      ),
      "installed/node_modules/workflow/index.js": "",
      "installed/node_modules/@workflow/core/package.json": metadata(
        "@workflow/core",
        "5.1.0",
      ),
      "installed/node_modules/@workflow/core/index.js": "",
      "installed/node_modules/@workflow/world-local/package.json": metadata(
        "@workflow/world-local",
        "9.8.7",
      ),
      "installed/node_modules/@workflow/world-local/index.js": "",
    },
    async (directory) => {
      const host = join(directory, "runtime");
      await mkdir(join(host, "node_modules"), { recursive: true });
      await symlink(
        join(directory, "installed/node_modules/workflow"),
        join(host, "node_modules/workflow"),
      );
      const observed = await observedToolchain(host);
      assert.equal(observed.world, "@workflow/world-local@9.8.7");
      assert.equal(
        (await qualifiedToolchain(observed, host)).world,
        observed.world,
      );
    },
  );
});
