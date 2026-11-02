import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { candidateCompiler } from "../tools/workflow-candidate-program.ts";
import {
  analyzeWorkflowCandidate,
  createWorkflowCandidateAnalyzer,
} from "../tools/workflow-candidate-source.ts";
import { candidatePackageRoot } from "./candidate-package-fixture.ts";
import { candidateSource } from "./workflow-candidate-fixtures.ts";

await test("CLV-176 candidate fixtures reuse declarations with fresh programs and sources", () => {
  const compile = candidateCompiler({ packageRoot: candidatePackageRoot });
  const first = compile(candidateSource("return 1;"));
  const second = compile(candidateSource("process.exit(0);"));
  assert.notEqual(first.program, second.program);
  assert.notEqual(
    first.program.getTypeChecker(),
    second.program.getTypeChecker(),
  );
  assert.notEqual(first.source, second.source);
  assert.match(first.source.text, /return 1/);
  assert.match(second.source.text, /process.exit/);
  for (const [name, source] of first.modules)
    assert.equal(second.modules.get(name), source, name);
});

await test("CLV-176 declaration reuse observes changed installed files", () => {
  const compile = candidateCompiler({ packageRoot: candidatePackageRoot });
  const source = candidateSource("return 1;");
  const first = compile(source);
  const declaration = first.modules.get("cloving/workflows");
  assert.ok(declaration);
  const original = readFileSync(declaration.fileName, "utf8");
  try {
    writeFileSync(
      declaration.fileName,
      original + "\nexport interface CompilerProbe {}\n",
    );
    const second = compile(source).modules.get("cloving/workflows");
    assert.ok(second);
    assert.notEqual(second, declaration);
    assert.match(second.text, /CompilerProbe/);
  } finally {
    writeFileSync(declaration.fileName, original);
  }
  assert.equal(
    compile(source).modules.get("cloving/workflows")?.text,
    original,
  );
});

await test("CLV-176 a shared candidate compiler keeps analysis independent of fixture order", () => {
  const analyze = createWorkflowCandidateAnalyzer({
    packageRoot: candidatePackageRoot,
  });
  const pure = candidateSource("return Math.abs(-1);");
  const effect = candidateSource("process.exit(0);");
  const clean = analyze(pure);
  const refused = analyze(effect);
  const installed = { packageRoot: candidatePackageRoot };
  assert.deepEqual(analyzeWorkflowCandidate(pure, installed), clean);
  assert.deepEqual(analyzeWorkflowCandidate(effect, installed), refused);
  assert.deepEqual(clean.analysis.directEffects, []);
  assert.ok(refused.analysis.directEffects.length > 0);
  assert.deepEqual(analyze(pure), clean);
  assert.deepEqual(analyze(effect), refused);
});

await test("CLV-176 shared and single-use analyzers inspect the same helper files", () => {
  const installed = {
    packageRoot: candidatePackageRoot,
    helpers: { "shared/helper.ts": "export function helper() { return 1; }" },
  };
  const analyze = createWorkflowCandidateAnalyzer(installed);
  const source =
    'import { helper } from "./shared/helper.ts";\n' +
    candidateSource("return helper();");
  const result = analyze(source);
  assert.deepEqual(result.analysis.localSources, ["shared/helper.ts"]);
  assert.deepEqual(result.analysis.directEffects, []);
  assert.deepEqual(analyzeWorkflowCandidate(source, installed), result);
});
