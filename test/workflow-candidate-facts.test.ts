import assert from "node:assert/strict";
import ts from "typescript";
import { test } from "node:test";
import { cp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { record } from "../src/protocol.ts";
import { admitWorkflowCandidate } from "../tools/admit-workflow.ts";
import { isCandidateFacts } from "../tools/workflow-candidate-facts.ts";
import { retainWorkflowBundle } from "../tools/workflow-bundles.ts";
import { rememberWorkflowBuild } from "../tools/self-host-build-cache.ts";
import { candidatePackageRoot } from "./candidate-package-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";
import {
  candidateDeclaration,
  validCandidateSource,
} from "./workflow-candidate-fixtures.ts";

async function changedProof(input: {
  readonly root: string;
  readonly source: string;
  readonly invalid: string | undefined;
}): Promise<string> {
  const project = join(input.root, "proof-project");
  await rm(project, { recursive: true, force: true });
  await cp(input.source, project, { recursive: true });
  const file = join(project, "analysis.json");
  if (input.invalid === undefined) await rm(file);
  else await writeFile(file, input.invalid);
  return await retainWorkflowBundle({
    directory: join(input.root, "bundles"),
    repository: candidatePackageRoot,
    project,
  });
}

await test("CLV-347 missing, stale and malformed semantic proofs fall back to current source analysis", () =>
  withFiles({}, async (root) => {
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
    const [index] = (await readdir(root)).filter((name) =>
      name.endsWith(".build"),
    );
    assert.ok(index);
    const id = await readFile(join(root, index), "utf8");
    const directory = join(root, "bundles");
    const source = join(directory, id);
    const proof = record(
      JSON.parse(await readFile(join(source, "analysis.json"), "utf8")),
    );
    assert.ok(proof);
    const original = ts.sys.readFile.bind(ts.sys);
    const reads: string[] = [];
    ts.sys.readFile = (file, encoding) => {
      reads.push(file);
      return original(file, encoding);
    };
    try {
      for (const invalid of [
        undefined,
        "{",
        JSON.stringify({ schemaVersion: 99 }),
        JSON.stringify({ schemaVersion: 1, key: "stale", facts: proof }),
        JSON.stringify({ schemaVersion: 1 }),
        JSON.stringify({ ...proof, facts: {} }),
        JSON.stringify({ ...proof, unexpected: true }),
      ]) {
        const bundleDigest = await changedProof({ root, source, invalid });
        await rememberWorkflowBuild({
          project: join(root, index.slice(0, -6)),
          bundleDigest,
        });
        reads.length = 0;
        assert.deepEqual(await admitWorkflowCandidate(input, installed), first);
        assert.ok(
          reads.some((name) => name.endsWith(".d.ts")),
          "A bad proof bypassed semantic analysis.",
        );
      }
    } finally {
      ts.sys.readFile = original;
    }
  }));

await test("CLV-347 cached semantic facts require the complete versioned data shape", () => {
  const totals = {
    effects: [{ capability: "claude", method: "run-turn" }],
    knownCallCount: 1,
    knownUnitTotal: 1,
    unsupportedForms: [],
  };
  const analysis = {
    ...totals,
    imports: [
      {
        module: "cloving/workflows",
        names: ["loadCycle"],
        source: "helpers/read.ts",
      },
    ],
    directEffects: [],
    localSources: [],
    commandWaits: [null, "check"],
    workflows: { work: totals },
  };
  const facts = {
    analysis,
    installedExports: { "cloving/workflows": ["loadCycle"] },
  };
  assert.ok(isCandidateFacts(facts));
  for (const invalid of [
    null,
    [],
    { ...facts, authority: true },
    { ...facts, installedExports: [] },
    { ...facts, installedExports: { invalid: null } },
  ])
    assert.equal(isCandidateFacts(invalid), false);
  for (const invalid of [
    { unknown: true },
    { effects: null },
    { effects: [{}] },
    { effects: [{ capability: "claude", method: 1 }] },
    { knownCallCount: -1 },
    { knownUnitTotal: 0.5 },
    { knownCallCount: null },
    { unsupportedForms: null },
    { directEffects: null },
    { imports: null },
    { imports: [{}] },
    { imports: [{ module: "a", names: [], source: null }] },
    { localSources: null },
    { commandWaits: null },
    { commandWaits: [1] },
    { workflows: null },
    { workflows: { invalid: {} } },
  ])
    assert.equal(
      isCandidateFacts({ ...facts, analysis: { ...analysis, ...invalid } }),
      false,
    );
});
