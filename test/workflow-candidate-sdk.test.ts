import assert from "node:assert/strict";
import { test } from "node:test";
import filesystem from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admitWorkflowCandidate } from "../tools/admit-workflow.ts";
import { analyzeWorkflowCandidate } from "../tools/workflow-candidate-source.ts";
import { checkWorkflowCandidate } from "../src/workflow-candidate.ts";
import {
  candidateDeclaration,
  combinedCandidateSource,
  validCandidateSource,
} from "./workflow-candidate-fixtures.ts";
import { withConsumer, servicePrelude } from "./world-host-fixture.ts";

await test("CLV-121 admission refuses source findings before compilation or execution", async () => {
  assert.deepEqual(
    await admitWorkflowCandidate({
      source: combinedCandidateSource,
      declaration: candidateDeclaration,
    }),
    { kind: "refused", codes: ["missing-export", "undeclared-effect"] },
  );
  assert.deepEqual(
    await admitWorkflowCandidate({
      source: validCandidateSource,
      declaration: {},
    }),
    { kind: "refused", codes: ["invalid-declaration"] },
  );
});

await test("CLV-121 admission compiles a valid candidate with real SDK handlers without sending", async () => {
  const result = await admitWorkflowCandidate({
    source: validCandidateSource,
    declaration: candidateDeclaration,
  });
  assert.equal(result.kind, "admitted");
  assert.deepEqual(Object.keys(result).sort(), ["artifactDigest", "kind"]);
  assert.match(result.artifactDigest, /^[0-9a-f]{64}$/);
});

await test("CLV-121 a real SDK compiler rejection returns only a fixed compile-failed code", async () => {
  const source = `const candidate = 1;\n${validCandidateSource}`;
  assert.deepEqual(
    checkWorkflowCandidate({
      declaration: candidateDeclaration,
      ...analyzeWorkflowCandidate(source),
    }),
    [],
  );
  assert.deepEqual(
    await admitWorkflowCandidate({ source, declaration: candidateDeclaration }),
    { kind: "refused", codes: ["compile-failed"] },
  );
});

await test("CLV-121 non-roundtrippable source is refused before byte-changing compilation", async () => {
  assert.deepEqual(
    await admitWorkflowCandidate({
      source: validCandidateSource + "\ud800",
      declaration: candidateDeclaration,
    }),
    { kind: "refused", codes: ["unsupported-source"] },
  );
});

await test("CLV-121 an unavailable compiler executable returns a fixed refusal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cloving-candidate-failure-"));
  const executable = process.execPath;
  try {
    Object.defineProperty(process, "execPath", {
      value: join(directory, "missing-node"),
    });
    assert.deepEqual(
      await admitWorkflowCandidate({
        source: validCandidateSource,
        declaration: candidateDeclaration,
      }),
      { kind: "refused", codes: ["compile-failed"] },
    );
  } finally {
    Object.defineProperty(process, "execPath", { value: executable });
    await rm(directory, { recursive: true, force: true });
  }
});

await test("CLV-121 unavailable temporary storage returns a fixed refusal without compiler details", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cloving-candidate-storage-"));
  const previous = process.env["TMPDIR"];
  try {
    process.env["TMPDIR"] = join(directory, "unavailable");
    assert.deepEqual(
      await admitWorkflowCandidate({
        source: validCandidateSource,
        declaration: candidateDeclaration,
      }),
      { kind: "refused", codes: ["compile-failed"] },
    );
  } finally {
    if (previous === undefined) delete process.env["TMPDIR"];
    else process.env["TMPDIR"] = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

function corruptCompilerManifest(manifest: unknown): () => void {
  const original = filesystem.readFile;
  Reflect.set(
    filesystem,
    "readFile",
    async (...args: Parameters<typeof original>) => {
      if (
        typeof args[0] === "string" &&
        args[0].endsWith("/artifacts/manifest.json")
      )
        return JSON.stringify(manifest);
      return original(...args);
    },
  );
  syncBuiltinESMExports();
  return () => {
    filesystem.readFile = original;
    syncBuiltinESMExports();
  };
}

for (const manifest of [
  [],
  {},
  { workflows: {} },
  {
    workflows: {
      "candidate.ts": {
        first: { workflowId: "first" },
        second: { workflowId: "second" },
      },
    },
  },
]) {
  await test(`CLV-121 compiler output must contain exactly one valid workflow: ${JSON.stringify(manifest)}`, async () => {
    const restore = corruptCompilerManifest(manifest);
    try {
      assert.deepEqual(
        await admitWorkflowCandidate({
          source: validCandidateSource,
          declaration: candidateDeclaration,
        }),
        { kind: "refused", codes: ["compile-failed"] },
      );
    } finally {
      restore();
    }
  });
}

await test("CLV-121 the admitted source completes through compiled SDK handlers and a registered claude fake destination", () =>
  withConsumer(validCandidateSource, async (consumer) => {
    const result = await consumer.run(`${servicePrelude}
const registration = fakeRegistration([]);
registration.manifest = { ...registration.manifest, capabilities: ["claude"] };
registration.effectLimit = 1;
const service = await hosted({ registrations: [registration], workflow: workflows.candidate });
const runId = await submitted("candidate-1");
await until(async () => (await stateOf(runId)) === "completed");
const run = (await asked("status", { runId })).run;
const world = (await tagged())[0];
const output = await getRun(world.receipt).returnValue;
print({ state: run.state, budget: run.budget, sends: lines("destination.log").length, effects: run.effects.length, output });
await service.close();
`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.lines.length, 1);
    const line = result.lines[0];
    assert.equal(Reflect.get(Object(line), "state"), "completed");
    assert.deepEqual(Reflect.get(Object(line), "budget"), {
      limit: 1,
      spent: 1,
    });
    assert.equal(Reflect.get(Object(line), "sends"), 1);
    assert.equal(Reflect.get(Object(line), "effects"), 1);
    const output: unknown = Reflect.get(Object(line), "output");
    assert.equal(Reflect.get(Object(output), "receipt"), "receipt-1");
  }));
