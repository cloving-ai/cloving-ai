import assert from "node:assert/strict";
import childProcess from "node:child_process";
import filesystem from "node:fs/promises";
import ts from "typescript";
import { cp, readFile, readdir, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { admitWorkflowCandidate } from "../tools/admit-workflow.ts";
import { candidateCache } from "../tools/workflow-candidate-cache.ts";
import { candidatePackageRoot } from "./candidate-package-fixture.ts";
import { observedReads } from "./file-read-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";
import {
  candidateDeclaration,
  validCandidateSource,
} from "./workflow-candidate-fixtures.ts";

await test("CLV-347 an exact verified restart cache hit reuses semantic facts and rechecks current admission", () =>
  withFiles({}, async (root) => {
    const installed = {
      packageRoot: candidatePackageRoot,
      cacheDirectory: root,
    };
    const input = {
      source: validCandidateSource,
      declaration: candidateDeclaration,
    };
    const original = ts.sys.readFile.bind(ts.sys);
    const reads: string[] = [];
    ts.sys.readFile = (file, encoding) => {
      if (file.endsWith(".d.ts")) reads.push(file);
      return original(file, encoding);
    };
    try {
      const first = await admitWorkflowCandidate(input, installed);
      assert.equal(first.kind, "admitted");
      assert.ok(reads.length > 0);
      reads.length = 0;
      assert.deepEqual(await admitWorkflowCandidate(input, installed), first);
      assert.equal(
        reads.length,
        0,
        "A verified hit rebuilt the TypeScript program.",
      );
      const changed = {
        ...input,
        declaration: { ...input.declaration, methods: { claude: ["other"] } },
      };
      assert.deepEqual(await admitWorkflowCandidate(changed, installed), {
        kind: "refused",
        codes: ["undeclared-effect"],
      });
    } finally {
      ts.sys.readFile = original;
    }
  }));

await test("CLV-347 unchanged restart admission reuses verified SDK artifacts and rechecks every declaration", () =>
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

await test("CLV-347 fact bytes replaced after bundle verification cannot erase a declared effect", () =>
  withFiles({}, async (root) => {
    const installed = {
      packageRoot: candidatePackageRoot,
      cacheDirectory: root,
    };
    const input = {
      source: validCandidateSource,
      declaration: candidateDeclaration,
    };
    assert.equal(
      (await admitWorkflowCandidate(input, installed)).kind,
      "admitted",
    );
    const original = filesystem.readFile;
    const intercepted = { count: 0 };
    Reflect.set(
      filesystem,
      "readFile",
      async (...parameters: readonly unknown[]) => {
        const result: unknown = await Reflect.apply(
          original,
          filesystem,
          parameters,
        );
        const matching =
          String(parameters[0]).endsWith("/analysis.json") &&
          typeof result === "string";
        intercepted.count += matching ? 1 : 0;
        return matching
          ? result.replace(/"effects":\[\{[^\]]+\}\]/g, '"effects":[]')
          : result;
      },
    );
    syncBuiltinESMExports();
    try {
      assert.deepEqual(
        await admitWorkflowCandidate(
          {
            ...input,
            declaration: {
              ...candidateDeclaration,
              methods: { claude: ["other"] },
            },
          },
          installed,
        ),
        { kind: "refused", codes: ["undeclared-effect"] },
      );
      assert.ok(intercepted.count > 0);
    } finally {
      filesystem.readFile = original;
      syncBuiltinESMExports();
    }
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
        "dist/src/steps/protected-effect.d.ts",
        "tools/workflow-candidate-source.ts",
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
      assert.equal(compiled(), 7);
      assert.equal(
        (await admitWorkflowCandidate(input, installed)).kind,
        "admitted",
      );
      assert.equal(compiled(), 7);
    });
  }));

await test("CLV-347 exact compiler library bytes invalidate semantic and SDK reuse without a manifest change", () =>
  withFiles({}, async (root) => {
    await withCompilerCount(async (compiled) => {
      const installed = {
        packageRoot: candidatePackageRoot,
        cacheDirectory: join(root, "cache"),
      };
      const input = {
        source: validCandidateSource,
        declaration: candidateDeclaration,
      };
      assert.equal(
        (await admitWorkflowCandidate(input, installed)).kind,
        "admitted",
      );
      const original = ts.sys.getExecutingFilePath.bind(ts.sys);
      const library = join(root, "compiler");
      await cp(dirname(original()), library, { recursive: true });
      const file = join(library, "lib.es2024.d.ts");
      await writeFile(file, (await readFile(file, "utf8")) + "\n");
      ts.sys.getExecutingFilePath = () => join(library, basename(original()));
      try {
        assert.equal(
          (await admitWorkflowCandidate(input, installed)).kind,
          "admitted",
        );
        assert.equal(compiled(), 2);
      } finally {
        ts.sys.getExecutingFilePath = original;
      }
    });
  }));

await test("CLV-347 a candidate cache key keeps 16 TypeScript library reads in flight, so a busy machine does not wait for each library file in turn", () =>
  withFiles({ "project/workflows/turn.ts": "export {};" }, async (root) => {
    const library = dirname(ts.sys.getExecutingFilePath());
    const input = {
      packageRoot: resolve(import.meta.dirname, ".."),
      project: join(root, "project"),
      cacheDirectory: join(root, "cache"),
    };
    const serial = await candidateCache(input);
    const { value: cache, peak } = await observedReads(
      () => candidateCache(input),
      { within: library },
    );
    assert.notEqual(cache, undefined);
    assert.equal(cache?.key, serial?.key);
    assert.equal(peak, 16, `outstanding library reads: ${String(peak)}`);
  }));
