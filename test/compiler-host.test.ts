import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import ts from "typescript";
import { fixtureCompiler } from "./compiler-host-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";
import { withProgram } from "./quality/program-fixture.ts";

await test("CLV-176 quality fixtures reuse declarations with independent validation", async () => {
  await withFiles(
    {
      "shared.d.ts": "export interface Shared { readonly value: 1 }",
      "fixture.ts":
        'import type { Shared } from "./shared.js"; export const value: Shared = { value: 1 };',
    },
    async (directory) => {
      const shared = join(directory, "shared.d.ts");
      const fixture = join(directory, "fixture.ts");
      const options = {
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        strict: true,
        types: [],
      };
      const host = fixtureCompiler(options);
      const compile = () => ts.createProgram([shared, fixture], options, host);
      const first = compile();
      assert.deepEqual(ts.getPreEmitDiagnostics(first), []);
      const second = compile();
      assert.notEqual(second, first);
      assert.notEqual(second.getTypeChecker(), first.getTypeChecker());
      assert.notEqual(
        second.getSourceFile(fixture),
        first.getSourceFile(fixture),
      );
      assert.ok(second.getSourceFile(shared) === first.getSourceFile(shared));
      await writeFile(shared, "export interface Shared { readonly value: 2 }");
      const changed = compile();
      assert.notEqual(
        changed.getSourceFile(shared),
        first.getSourceFile(shared),
      );
      assert.ok(
        ts.getPreEmitDiagnostics(changed).some((entry) => entry.code === 2322),
      );
      await writeFile(
        fixture,
        'import type { Shared } from "./shared.js"; export const value: Shared = { value: 2 };',
      );
      assert.deepEqual(ts.getPreEmitDiagnostics(compile()), []);
      assert.equal(
        host.getSourceFile(join(directory, "absent.d.ts"), options.target),
        undefined,
      );
    },
  );
});

await test("CLV-176 shared quality hosts do not retain globals from earlier fixtures", async () => {
  for (const declared of [true, false, true, false]) {
    const found = await withProgram(
      {
        "fixture.ts": declared
          ? "declare global { var fixtureGlobal: number; } export {};"
          : "export {};",
      },
      (program) =>
        program
          .getTypeChecker()
          .resolveName(
            "fixtureGlobal",
            undefined,
            ts.SymbolFlags.Value,
            false,
          ) !== undefined,
    );
    assert.equal(found, declared);
  }
});
