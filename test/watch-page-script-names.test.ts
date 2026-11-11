import assert from "node:assert/strict";
import { test } from "node:test";
import ts from "typescript";
import { pageDocument } from "../src/cli/watch-page.ts";

const unknownNameCodes = new Set([2304, 2552, 2580, 2582, 2591]);
const scriptFile = "/page/script.js";

function pageScript(): string {
  const [, script = ""] =
    /<script type="module">([\s\S]*)<\/script>/.exec(pageDocument()) ?? [];
  return script;
}

function browserProgram(script: string): ts.Program {
  const options: ts.CompilerOptions = {
    allowJs: true,
    checkJs: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2024,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ["lib.es2024.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
    types: [],
  };
  const host = ts.createCompilerHost(options);
  const source = ts.createSourceFile(
    scriptFile,
    script,
    ts.ScriptTarget.ES2024,
    true,
    ts.ScriptKind.JS,
  );
  const sourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, language) =>
    name === scriptFile ? source : sourceFile(name, language);
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (name) => name === scriptFile || fileExists(name);
  return ts.createProgram([scriptFile], options, host);
}

function unknownNames(script: string): readonly string[] {
  const program = browserProgram(script);
  const source = program.getSourceFile(scriptFile);
  assert.ok(source !== undefined);
  return program
    .getSemanticDiagnostics(source)
    .filter((diagnostic) => unknownNameCodes.has(diagnostic.code))
    .map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    );
}

await test("CLV-358 each name that the watch page script uses is defined in its scope or is a JavaScript or browser global", () => {
  assert.deepEqual(unknownNames(pageScript()), []);
});

await test("CLV-358 the name check finds a helper that is only a local name of another function", () => {
  const found = unknownNames(
    "function other(missingHelper) { return missingHelper; }\nfunction Shown(model) { return missingHelper(model); }",
  );
  assert.equal(found.length, 1);
  assert.match(String(found[0]), /missingHelper/);
});

await test("CLV-358 the name check refuses a Node global that a browser does not have", () => {
  const found = unknownNames(
    'function Shown() { return Buffer.from("x").length + process.pid; }',
  );
  assert.equal(found.length, 2);
  assert.match(found.join("\n"), /Buffer/);
  assert.match(found.join("\n"), /process/);
});
