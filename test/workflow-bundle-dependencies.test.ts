import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  workflowBundleDependencies,
  workflowPackageRoot,
} from "../tools/workflow-bundle-dependencies.ts";
import { withFiles } from "./quality/files-fixture.ts";

const product = '{"name":"synthetic-product","version":"1"}';
const parent = JSON.stringify({
  name: "parent",
  version: "1",
  dependencies: { child: "1" },
  optionalDependencies: { absent: "1" },
  peerDependencies: { peer: "1" },
  peerDependenciesMeta: { peer: { optional: true } },
});
const child = '{"name":"child","version":"1","dependencies":{"parent":"1"}}';

await test("CLV-153 dependency identity captures transitive manifests, cycles and absent optional packages deterministically", () =>
  withFiles(
    {
      "package.json": product,
      "node_modules/parent/package.json": parent,
      "node_modules/child/package.json": child,
    },
    async (root) => {
      const input = { product: root, packages: ["parent"] };
      const first = await workflowBundleDependencies(input);
      const parsed: unknown = JSON.parse(first);
      assert.deepEqual(parsed, {
        node: process.version,
        product: createHash("sha256").update(product).digest("hex"),
        roots: { parent: 0 },
        packages: [
          {
            manifest: parent,
            dependencies: { absent: null, child: 1, peer: null },
          },
          { manifest: child, dependencies: { parent: 0 } },
        ],
      });
      assert.equal(await workflowBundleDependencies(input), first);
      await writeFile(
        join(root, "node_modules/child/package.json"),
        child.replace('"version":"1"', '"version":"2"'),
      );
      assert.notEqual(await workflowBundleDependencies(input), first);
    },
  ));

await test("CLV-153 a required missing dependency refuses retention", () =>
  withFiles({ "package.json": product }, async (root) => {
    await assert.rejects(
      workflowBundleDependencies({ product: root, packages: ["missing"] }),
      { message: "workflow-dependency-unavailable" },
    );
  }));

for (const manifest of ["null", "{}", '{"name":"invalid"}', "invalid JSON"]) {
  await test(`CLV-153 malformed installed dependency identity is refused: ${manifest}`, () =>
    withFiles(
      {
        "package.json": product,
        "node_modules/invalid/package.json": manifest,
      },
      async (root) => {
        await assert.rejects(
          workflowBundleDependencies({ product: root, packages: ["invalid"] }),
        );
      },
    ));
}

await test("CLV-153 unexpected package resolution errors remain failures", () =>
  withFiles({ "package.json": product }, async (root) => {
    await assert.rejects(
      workflowBundleDependencies({ product: root, packages: ["node:fs"] }),
      { code: "ERR_INVALID_URL_SCHEME" },
    );
  }));

await test("CLV-153 dependency capture resolves product metadata above an installed dist directory", () =>
  withFiles(
    {
      "package.json": product,
      "dist/marker": "",
      "node_modules/fixture/package.json": '{"name":"fixture","version":"1"}',
    },
    async (root) => {
      assert.equal(
        await workflowBundleDependencies({
          product: join(root, "dist"),
          packages: ["fixture"],
        }),
        await workflowBundleDependencies({
          product: root,
          packages: ["fixture"],
        }),
      );
    },
  ));

await test("CLV-347 the compiled product skips emitted package metadata whose public executable is outside that directory", () =>
  withFiles(
    {
      "package.json": JSON.stringify({ bin: { cloving: "dist/src/cli.js" } }),
      "dist/package.json": JSON.stringify({
        bin: { cloving: "dist/src/cli.js" },
      }),
      "dist/src/cli.js": "",
    },
    async (root) => {
      assert.equal(await workflowPackageRoot(join(root, "dist")), root);
      assert.equal(await workflowPackageRoot(root), root);
    },
  ));

await test("CLV-347 a source package keeps its root before its public executable is built", () =>
  withFiles(
    {
      "package.json": JSON.stringify({ bin: { cloving: "dist/src/cli.js" } }),
      "src/cli.ts": "",
    },
    async (root) => {
      assert.equal(await workflowPackageRoot(root), root);
    },
  ));

for (const [name, parent] of [
  ["malformed", "{"],
  ["unrelated", '{"name":"other","version":"1"}'],
  ["not an object", "null"],
] as const) {
  await test(`CLV-347 a valid nearest package in dist keeps its root when the optional parent is ${name}`, () =>
    withFiles(
      { "package.json": parent, "dist/package.json": product },
      async (root) => {
        assert.equal(
          await workflowPackageRoot(join(root, "dist")),
          join(root, "dist"),
        );
      },
    ));
}

await test("CLV-347 a valid nearest package in dist keeps its root when the optional parent cannot be read", () =>
  withFiles(
    { "package.json": product, "dist/package.json": product },
    async (root) => {
      const parent = join(root, "package.json");
      await chmod(parent, 0);
      try {
        await assert.rejects(readFile(parent, "utf8"), { code: "EACCES" });
        assert.equal(
          await workflowPackageRoot(join(root, "dist")),
          join(root, "dist"),
        );
      } finally {
        await chmod(parent, 0o600);
      }
    },
  ));

await test("CLV-347 malformed selected package metadata still refuses discovery", () =>
  withFiles(
    { "package.json": product, "dist/package.json": "{" },
    async (root) => {
      await assert.rejects(
        workflowPackageRoot(join(root, "dist")),
        SyntaxError,
      );
    },
  ));
