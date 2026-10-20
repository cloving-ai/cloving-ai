import assert from "node:assert/strict";
import { test } from "node:test";
import { generateWorkflow } from "../src/chats/workflow-generation.ts";
import {
  acceptedAnalysis,
  generationAvailability,
} from "./chats-workflow-generation-fixture.ts";
import {
  candidate,
  itemAt,
  questionCandidate,
} from "./chats-analysis-fixture.ts";

await test("CLV-122 generator refuses unsafe accepted identifiers, names and prose without echoing them", () => {
  for (const field of ["id", "name", "scope"])
    for (const text of ["@synthetic", "password=SYNTHETIC", "x".repeat(241)]) {
      const analysis = acceptedAnalysis();
      Reflect.set(analysis.process, field, text);
      const result = generateWorkflow(analysis, generationAvailability);
      assert.equal(result.kind, "refused");
      assert.deepEqual(Object.keys(result).sort(), ["codes", "kind"]);
      assert.equal(JSON.stringify(result).includes(text), false);
    }
  const analysis = acceptedAnalysis();
  Reflect.set(
    itemAt(analysis.process.inputs),
    "description",
    "worker@example.test",
  );
  assert.deepEqual(generateWorkflow(analysis, generationAvailability), {
    kind: "refused",
    codes: ["email-form"],
  });
});

await test("CLV-122 unavailable public exports, capabilities and methods produce explicit gaps without artifacts", () => {
  for (const [module, names] of Object.entries(generationAvailability.exports))
    for (const name of names) {
      const availability = structuredClone(generationAvailability);
      Reflect.set(
        availability.exports,
        module,
        names.filter((entry) => entry !== name),
      );
      const result = generateWorkflow(acceptedAnalysis(), availability);
      assert.equal(result.kind, "gap");
      assert.equal(Object.hasOwn(result, "artifact"), false);
      assert.ok(
        result.report.gaps.includes(`missing-export:${module}#${name}`),
      );
    }
  for (const [methods, code] of [
    [{}, "missing-capability:claude"],
    [{ claude: [] }, "missing-method:claude#run-turn"],
  ] as const) {
    const result = generateWorkflow(acceptedAnalysis(), {
      ...generationAvailability,
      methods,
    });
    assert.equal(result.kind, "gap");
    assert.deepEqual(result.report.gaps, [code]);
  }
});

await test("CLV-122 unresolved questions and unsupported or ambiguous control flow fail closed", () => {
  const variants = [
    [questionCandidate(), "unresolved-analysis-question"],
    [candidate(), "unsupported-branch"],
    [candidate(), "unsupported-loops"],
    [candidate(), "ambiguous-stages"],
    [candidate(), "effect-limit"],
  ] as const;
  itemAt(variants[1][0].process.branches).condition =
    "Interpret the historical exception.";
  itemAt(variants[2][0].process.loops).exitCondition =
    "Choose from the assistant claim.";
  itemAt(variants[3][0].process.stages, 4).kind = "explicit-human-instruction";
  itemAt(variants[4][0].process.loops).maxIterations = 51;
  for (const [input, code] of variants) {
    const result = generateWorkflow(
      acceptedAnalysis(input),
      generationAvailability,
    );
    assert.equal(result.kind, "gap");
    assert.equal(Object.hasOwn(result, "artifact"), false);
    assert.ok(
      result.report.gaps.includes(code),
      JSON.stringify(result.report.gaps),
    );
  }
});

await test("CLV-122 accepted synthetic review projection generates one deterministic private-report candidate without mutation", () => {
  const analysis = acceptedAnalysis();
  const before = JSON.stringify([analysis, generationAvailability]);
  const result = generateWorkflow(analysis, generationAvailability);
  assert.equal(result.kind, "generated");
  assert.equal(
    JSON.stringify(generateWorkflow(analysis, generationAvailability)),
    JSON.stringify(result),
  );
  assert.equal(JSON.stringify([analysis, generationAvailability]), before);
  assert.equal(result.artifact.functionName, "clvFunction1");
  assert.equal(result.artifact.declaration.workflow.effectLimit, 6);
  assert.deepEqual(result.artifact.declaration.methods, {
    claude: ["run-turn"],
  });
  assert.deepEqual(result.report.projection, {
    version: "review-repair/v1",
    stageIds: ["review", "repair"],
    maximumIterations: 3,
    effectLimit: 6,
  });
  assert.deepEqual(
    result.report.stages.map((stage) => stage.disposition),
    [
      "execute",
      "execute",
      "annotation",
      "annotation",
      "annotation",
      "annotation",
      "annotation",
      "annotation",
    ],
  );
  assert.deepEqual(
    result.report.nonGates.map((item) => item.reason),
    ["routine-repair", "accidental-interruption", "tool-imposed-confirmation"],
  );
  assert.deepEqual(result.report.limitations, analysis.limitations);
  assert.deepEqual(result.report.gaps, []);
  assert.deepEqual(result.artifact.declaration.workflow.input, {
    maximumBytes: 16_384,
    fields: { clvInput1: { type: "string" } },
  });
  assert.equal(result.artifact.assets.length, 2);
});

await test("CLV-122 factual decisions become required ordinal run inputs and every public name is mapped privately", () => {
  const input = candidate();
  input.process.gates.push({
    ...itemAt(input.process.gates),
    id: "facts",
    type: "factual-input",
    description: "Supply the current test command.",
  });
  const result = generateWorkflow(
    acceptedAnalysis(input),
    generationAvailability,
  );
  assert.equal(result.kind, "generated");
  assert.deepEqual(result.artifact.declaration.workflow.input.fields, {
    clvInput1: { type: "string" },
    clvInput2: { type: "string" },
  });
  assert.ok(result.artifact.source.includes("clvInput2: string"));
  assert.deepEqual(result.artifact.assets[0]?.parameters.at(-1), {
    name: "clvInput2",
    description: "Supply the current test command.",
  });
  assert.ok(
    result.report.nameMap.some(
      (entry) => entry.id === "facts" && entry.name === "clvInput2",
    ),
  );
  assert.ok(
    result.report.nameMap.some(
      (entry) => entry.id === "design" && entry.name === "clv-gate-1",
    ),
  );
  assert.ok(
    result.report.nameMap.some(
      (entry) => entry.id === "review" && entry.name === "clvAsset1",
    ),
  );
  assert.deepEqual(result.report.inputs, input.process.inputs);
});

await test("CLV-122 interpretation of historical or unsupported loop and gate claims is a gap", () => {
  for (const part of ["loops", "gates"] as const) {
    const input = candidate();
    itemAt<{ kind: string }>(input.process[part]).kind = "exception";
    const result = generateWorkflow(
      acceptedAnalysis(input),
      generationAvailability,
    );
    assert.equal(result.kind, "gap");
    assert.ok(result.report.gaps.includes(`unsupported-${part}`));
  }
});

await test("CLV-122 private report retains process summaries and unresolved questions", () => {
  const analysis = acceptedAnalysis(questionCandidate());
  const result = generateWorkflow(analysis, generationAvailability);
  assert.equal(result.kind, "gap");
  assert.deepEqual(result.report.process, {
    id: analysis.process.id,
    name: analysis.process.name,
    scope: analysis.process.scope,
  });
  assert.deepEqual(result.report.openQuestion, analysis.openQuestion);
});

await test("CLV-122 absent control links, extra gates and an absent export module return gaps", () => {
  const inputs = Array.from({ length: 4 }, () => candidate());
  itemAt(inputs, 0).process.loops = [];
  itemAt(inputs, 1).process.branches = [];
  itemAt(itemAt(inputs, 2).process.gates).stageId = "historical-post";
  itemAt(inputs, 3).process.gates.push({
    ...itemAt(candidate().process.gates),
    id: "another-design",
  });
  for (const input of inputs) {
    const result = generateWorkflow(
      acceptedAnalysis(input),
      generationAvailability,
    );
    assert.equal(result.kind, "gap");
    assert.equal(Object.hasOwn(result, "artifact"), false);
  }
  const availability = structuredClone(generationAvailability);
  Reflect.deleteProperty(availability.exports, "cloving/workflows");
  const result = generateWorkflow(acceptedAnalysis(), availability);
  assert.equal(result.kind, "gap");
  assert.deepEqual(result.report.gaps, [
    "missing-export:cloving/workflows#CycleOutcome",
    "missing-export:cloving/workflows#ProtectedResult",
  ]);
});
