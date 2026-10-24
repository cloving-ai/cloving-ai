import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import { test } from "node:test";
import ts from "typescript";
import { testMilliseconds } from "../test-timing.ts";
import { withProgram } from "./program-fixture.ts";

await test("CLV-179 isolated quality programs reuse standard library syntax and still check each fixture", async () => {
  const sources = { "fixture.ts": "export const value: number = 1;" };
  const inspect = (program: ts.Program) => ({
    library: program
      .getSourceFiles()
      .find((source) => basename(source.fileName) === "lib.es2024.d.ts"),
    node: program
      .getSourceFiles()
      .find((source) => source.fileName.endsWith("/@types/node/fs.d.ts")),
    fixture: program.getSourceFile(program.getRootFileNames()[0] ?? ""),
  });
  const first = await withProgram(sources, inspect);
  const second = await withProgram(sources, inspect);
  assert.ok(first.library);
  assert.equal(second.library === first.library, true);
  assert.ok(first.node);
  assert.equal(second.node === first.node, true);
  assert.ok(first.fixture);
  assert.ok(second.fixture);
  assert.notEqual(second.fixture, first.fixture);
  await assert.rejects(
    withProgram(
      { "fixture.ts": "export const value: number = undefined;" },
      inspect,
    ),
    /Type 'undefined' is not assignable to type 'number'/,
  );
});

await test("CLV-179 fixture programs preserve distinct roots on case-sensitive systems", () => {
  const module = new URL("./compiler-host-fixture.ts", import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
import assert from "node:assert/strict";
import ts from "typescript";
ts.sys.useCaseSensitiveFileNames = true;
const files = ["/virtual/Foo.ts", "/virtual/foo.ts"];
const read = ts.sys.readFile.bind(ts.sys);
const exists = ts.sys.fileExists.bind(ts.sys);
ts.sys.readFile = (file, encoding) => files.includes(file) ? "export const value = 1;" : read(file, encoding);
ts.sys.fileExists = (file) => files.includes(file) || exists(file);
const { fixtureProgram } = await import(${JSON.stringify(module)});
const program = fixtureProgram(files, { noLib: true, types: [] });
assert.deepEqual(program.getSourceFiles().map(file => file.fileName).sort(), files);
`,
    ],
    { cwd: process.cwd(), encoding: "utf8", timeout: testMilliseconds(10000) },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});

await test("CLV-179 library reuse reads changed declaration bytes", async () => {
  const source = { "fixture.ts": "export const value = 1;" };
  const library = (program: ts.Program) =>
    program
      .getSourceFiles()
      .find((file) => basename(file.fileName) === "lib.es2024.d.ts");
  const first = await withProgram(source, library);
  assert.ok(first);
  const read = ts.sys.readFile.bind(ts.sys);
  const descriptor = Object.getOwnPropertyDescriptor(ts.sys, "readFile");
  assert.ok(descriptor);
  ts.sys.readFile = (file, encoding) =>
    file === first.fileName ? first.text + "\n" : read(file, encoding);
  try {
    const changed = await withProgram(source, library);
    assert.ok(changed);
    assert.notEqual(changed, first);
    assert.equal(changed.text, first.text + "\n");
  } finally {
    Object.defineProperty(ts.sys, "readFile", descriptor);
  }
});
