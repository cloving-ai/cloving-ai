import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { admitWorkflowCandidate } from "../tools/admit-workflow.ts";
import { candidatePackageRoot } from "./candidate-package-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";
import {
  candidateDeclaration,
  validCandidateSource,
} from "./workflow-candidate-fixtures.ts";

await test("CLV-347 unchanged restart admission reuses verified SDK artifacts and still analyzes every source", () =>
  withFiles({}, async (root) => {
    await withCompilerCount(async (compiled) => {
      const installed = {
        packageRoot: candidatePackageRoot,
        cacheDirectory: root,
      };
      const input = {
        source: validCandidateSource,
        declaration: candidateDeclaration,
      };
      const first = await admitWorkflowCandidate(input, installed);
      assert.equal(first.kind, "admitted");
      assert.deepEqual(await admitWorkflowCandidate(input, installed), first);
      assert.equal(compiled(), 1);
      assert.deepEqual(
        await admitWorkflowCandidate({ ...input, declaration: {} }, installed),
        { kind: "refused", codes: ["invalid-declaration"] },
      );
      const bundles = join(root, "bundles");
      const [bundle] = (await readdir(bundles)).filter((name) =>
        /^[a-f0-9]{64}$/.test(name),
      );
      assert.ok(bundle);
      const artifact = join(bundles, bundle, "artifacts/client.mjs");
      await writeFile(artifact, (await readFile(artifact, "utf8")) + "\n");
      assert.equal(
        (await admitWorkflowCandidate(input, installed)).kind,
        "admitted",
      );
      assert.equal(compiled(), 2);
    });
  }));

async function withCompilerCount(
  body: (compiled: () => number) => Promise<void>,
): Promise<void> {
  const original = childProcess.spawn;
  const calls: string[] = [];
  const tracked = (...argumentsList: readonly unknown[]) => {
    const text = JSON.stringify(argumentsList);
    if (text.includes("compile-workflows")) calls.push(text);
    const child: unknown = Reflect.apply(original, childProcess, argumentsList);
    if (!(child instanceof childProcess.ChildProcess))
      throw new Error("The compiler did not return a child process.");
    return child;
  };
  Reflect.set(childProcess, "spawn", tracked);
  syncBuiltinESMExports();
  try {
    await body(() => calls.length);
  } finally {
    childProcess.spawn = original;
    syncBuiltinESMExports();
  }
}

await test("CLV-347 compiler reuse invalidates changed source, helper, emitted product and dependency manifests", () =>
  withFiles({}, async (root) => {
    await withCompilerCount(async (compiled) => {
      const installed = {
        packageRoot: candidatePackageRoot,
        cacheDirectory: root,
      };
      const input = {
        source:
          'import { value } from "./helpers/value.ts";\nexport async function candidate() {\n  "use workflow";\n  return value();\n}',
        helpers: {
          "helpers/value.ts": "export function value() { return 1; }",
        },
        declaration: candidateDeclaration,
      };
      assert.equal(
        (await admitWorkflowCandidate(input, installed)).kind,
        "admitted",
      );
      for (const changed of [
        { ...input, source: input.source + "\n" },
        {
          ...input,
          helpers: {
            "helpers/value.ts": "export function value() { return 2; }",
          },
        },
      ])
        assert.equal(
          (await admitWorkflowCandidate(changed, installed)).kind,
          "admitted",
        );
      assert.equal(compiled(), 3);
      for (const name of [
        "dist/src/steps/protected-effect.js",
        "package.json",
      ]) {
        const path = join(candidatePackageRoot, name);
        const original = await readFile(path, "utf8");
        try {
          await writeFile(path, original + "\n");
          assert.equal(
            (await admitWorkflowCandidate(input, installed)).kind,
            "admitted",
          );
        } finally {
          await writeFile(path, original);
        }
      }
      assert.equal(compiled(), 5);
      assert.equal(
        (await admitWorkflowCandidate(input, installed)).kind,
        "admitted",
      );
      assert.equal(compiled(), 5);
    });
  }));
