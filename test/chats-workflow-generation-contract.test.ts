import assert from "node:assert/strict";
import { test } from "node:test";
import filesystem from "node:fs";
import promises from "node:fs/promises";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import ts from "typescript";
import { generateWorkflow } from "../src/chats/workflow-generation.ts";
import { candidateProgram } from "../tools/workflow-candidate-program.ts";
import {
  workflowDeclarations,
  workflowManifests,
} from "../tools/self-host-workflows.ts";
import { isWorkflowManifest } from "../tools/workflow-manifest.ts";
import { admitCompiled } from "../src/cli/validate.ts";
import { checkSubmission } from "../src/submission.ts";
import { ticketRegistrationTable } from "../src/daemon/ticket-registration.ts";
import { generatedArtifact } from "./chats-workflow-generation-sdk-fixture.ts";
import {
  acceptedAnalysis,
  generationAvailability,
} from "./chats-workflow-generation-fixture.ts";
import { withConsumer } from "./world-host-fixture.ts";
import { itemAt } from "./chats-analysis-fixture.ts";

function forbidGenerationEffects() {
  const calls: string[] = [];
  const targets = [
    { object: filesystem, key: "readFileSync" },
    { object: filesystem, key: "writeFileSync" },
    { object: promises, key: "readFile" },
    { object: promises, key: "writeFile" },
    { object: childProcess, key: "spawn" },
    { object: childProcess, key: "execFile" },
    { object: globalThis, key: "fetch" },
  ];
  const saved = targets.map((entry) => {
    const value: unknown = Reflect.get(entry.object, entry.key);
    Reflect.set(entry.object, entry.key, () => {
      calls.push(entry.key);
      throw new Error("generation-effect");
    });
    return { ...entry, value };
  });
  syncBuiltinESMExports();
  return {
    calls,
    restore: () => {
      for (const entry of saved)
        Reflect.set(entry.object, entry.key, entry.value);
      syncBuiltinESMExports();
    },
  };
}

function embeddedAssets(source: ts.SourceFile): readonly unknown[] {
  return source.statements.flatMap((statement) => {
    if (!ts.isVariableStatement(statement)) return [];
    return statement.declarationList.declarations.flatMap((declaration) => {
      if (
        !ts.isIdentifier(declaration.name) ||
        !/^clvAsset\d+$/.test(declaration.name.text) ||
        declaration.initializer === undefined
      )
        return [];
      const value: unknown = JSON.parse(
        declaration.initializer.getText(source),
      );
      return [value];
    });
  });
}

await test("CLV-122 generation performs no file, process, network or worker calls", () => {
  const analysis = acceptedAnalysis();
  const guard = forbidGenerationEffects();
  const forbidden = () => {
    throw new Error("generation-worker-call");
  };
  const key = Symbol.for("cloving.step-bridge/v1");
  const previous: unknown = Reflect.get(globalThis, key);
  Reflect.set(globalThis, key, { effect: forbidden, gate: forbidden });
  syncBuiltinESMExports();
  try {
    assert.equal(
      generateWorkflow(analysis, generationAvailability).kind,
      "generated",
    );
    assert.deepEqual(guard.calls, []);
  } finally {
    Reflect.deleteProperty(globalThis, key);
    if (previous !== undefined) Reflect.set(globalThis, key, previous);
    guard.restore();
  }
});

await test("CLV-122 source embeds exactly the returned JSON assets, typechecks and excludes private provenance and historical values", () => {
  const analysis = acceptedAnalysis();
  Reflect.set(
    itemAt(itemAt(analysis.process.stages).sourceRefs),
    "sourceId",
    "SYNTHETIC_CORPUS_SENTINEL",
  );
  Reflect.set(
    itemAt(analysis.process.stages, 3),
    "description",
    "SYNTHETIC_HISTORICAL_PARAMETER",
  );
  const result = generateWorkflow(analysis, generationAvailability);
  assert.equal(result.kind, "generated");
  const artifactText = JSON.stringify(result.artifact);
  assert.equal(artifactText.includes("SYNTHETIC_CORPUS_SENTINEL"), false);
  assert.equal(artifactText.includes("SYNTHETIC_HISTORICAL_PARAMETER"), false);
  assert.equal(artifactText.includes("sourceRefs"), false);
  assert.equal(artifactText.includes("counterevidenceRefs"), false);
  assert.equal(
    JSON.stringify(result.report).includes("SYNTHETIC_CORPUS_SENTINEL"),
    true,
  );
  const { program, source } = candidateProgram(result.artifact.source);
  assert.deepEqual(
    program
      .getSemanticDiagnostics(source)
      .map((diagnostic) =>
        ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
      ),
    [],
  );
  assert.deepEqual(embeddedAssets(source), result.artifact.assets);
});

await test("CLV-122 generated declaration loads and real compiled artifact admission accepts the unchanged contract and input envelope", () =>
  withConsumer(generatedArtifact().source, async (consumer) => {
    const artifact = generatedArtifact();
    const compiled: unknown = JSON.parse(
      await promises.readFile(
        join(consumer.directory, "artifacts/manifest.json"),
        "utf8",
      ),
    );
    assert.ok(isWorkflowManifest(compiled));
    const directory = join(consumer.directory, "declarations");
    await promises.mkdir(directory);
    await promises.writeFile(join(directory, "develop.ts"), artifact.source);
    await promises.writeFile(
      join(directory, "develop.declaration.json"),
      JSON.stringify(artifact.declaration.workflow),
    );
    const declarations = await workflowDeclarations(
      directory,
      workflowManifests(compiled),
    );
    assert.deepEqual(declarations, [
      { ...artifact.declaration.workflow, functionName: artifact.functionName },
    ]);
    const manifest = workflowManifests(compiled, declarations)[
      artifact.functionName
    ];
    const file = join(consumer.directory, "generated.workflow.json");
    await promises.writeFile(file, JSON.stringify(manifest));
    const admission = await admitCompiled(file, {
      file,
      capabilities: ["claude"],
    });
    assert.equal(admission.kind, "admitted", JSON.stringify(admission));
  }));

await test("CLV-122 submitted fields resolve to the declared current run envelope", async () => {
  const artifact = generatedArtifact();
  const declarations = [
    { ...artifact.declaration.workflow, functionName: artifact.functionName },
  ];
  const submission = { clvInput1: "Current synthetic changes." };
  assert.equal(
    checkSubmission(artifact.declaration.workflow.input, {
      workflowId: "clv-generated-1",
      source: "input",
      submission,
    }).kind,
    "valid",
  );
  assert.equal(
    checkSubmission(artifact.declaration.workflow.input, {
      workflowId: "clv-generated-1",
      source: "input",
      submission: { ...submission, extra: "no" },
    }).kind,
    "rejected",
  );
  const row = itemAt(
    ticketRegistrationTable(
      { repository: "current-workspace", command: undefined },
      declarations,
    ),
    4,
  );
  const resolution = await row.resolver.resolve({
    workflowId: row.workflowId,
    submission,
    commandId: "current-command",
    signal: new AbortController().signal,
  });
  assert.equal(resolution.kind, "resolved");
  assert.equal(
    typeof Reflect.get(Object(resolution.input), "cycleId"),
    "string",
  );
  assert.equal(
    Reflect.get(Object(resolution.input), "repository"),
    "current-workspace",
  );
  assert.deepEqual(Reflect.get(Object(resolution.input), "input"), submission);
  const input: unknown = resolution.input;
  assert.ok(input !== null && typeof input === "object");
  assert.deepEqual(Object.keys(input).sort(), [
    "cycleId",
    "input",
    "repository",
  ]);
});
