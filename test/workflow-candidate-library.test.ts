import assert from "node:assert/strict";
import { basename } from "node:path";
import { test } from "node:test";
import ts from "typescript";
import { candidateProgram } from "./candidate-package-fixture.ts";
import { validCandidateSource } from "./workflow-candidate-fixtures.ts";

await test("CLV-179 candidate programs reuse library syntax and refresh candidate and installed declaration syntax", () => {
  const first = candidateProgram(validCandidateSource);
  const nextText = validCandidateSource + "\n";
  const second = candidateProgram(nextText);
  const library = first.program
    .getSourceFiles()
    .find((file) => basename(file.fileName) === "lib.es2024.d.ts");
  assert.ok(library);
  assert.equal(second.program.getSourceFile(library.fileName), library);
  assert.notEqual(second.source, first.source);
  assert.equal(second.source.text, nextText);
  const surface = first.modules.get("cloving/workflows");
  assert.ok(surface);
  assert.notEqual(second.modules.get("cloving/workflows"), surface);
});

await test("CLV-179 candidate library reuse observes changed declaration bytes", () => {
  const first = candidateProgram(validCandidateSource);
  const library = first.program
    .getSourceFiles()
    .find((file) => basename(file.fileName) === "lib.es2024.d.ts");
  assert.ok(library);
  const descriptor = Object.getOwnPropertyDescriptor(ts.sys, "readFile");
  assert.ok(descriptor);
  const read = ts.sys.readFile.bind(ts.sys);
  ts.sys.readFile = (file, encoding) =>
    file === library.fileName ? library.text + "\n" : read(file, encoding);
  try {
    const changed = candidateProgram(validCandidateSource);
    const current = changed.program.getSourceFile(library.fileName);
    assert.ok(current);
    assert.notEqual(current, library);
    assert.equal(current.text, library.text + "\n");
  } finally {
    Object.defineProperty(ts.sys, "readFile", descriptor);
  }
});
