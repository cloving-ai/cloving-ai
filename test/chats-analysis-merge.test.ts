import assert from "node:assert/strict";
import { test } from "node:test";
import {
  accepted,
  batch,
  evidence,
  extendedBatch,
  questionBatch,
} from "./chats-analysis-merge-fixture.ts";
import { mergeAnalysisBatch } from "../src/chats/analysis-merge.ts";
import {
  candidate as fullCandidate,
  itemAt,
  records,
  ref,
  structure,
} from "./chats-analysis-fixture.ts";

await test("CLV-119 merges citations in global record order and appends items without changing inputs", () => {
  const previousResult = accepted();
  const next = batch([ref(4), ref(1), ref(4)]);
  const candidate = {
    ...next,
    process: {
      ...next.process,
      artifacts: [{ id: "artifact", description: "Artifact." }],
      stages: [
        {
          ...itemAt(next.process.stages),
          counterevidenceRefs: [ref(5), ref(2)],
        },
      ],
    },
  };
  const input = { previousResult, candidate, evidence, nextRecordIndex: 6 };
  const before = structuredClone(input);
  const result = mergeAnalysisBatch(input);
  assert.ok(result.accepted);
  const stage = itemAt(result.result.process.stages);
  assert.deepEqual(stage.sourceRefs, [ref(1), ref(4)]);
  assert.deepEqual(stage.counterevidenceRefs, [ref(2), ref(5)]);
  assert.deepEqual(
    result.result.process.artifacts,
    candidate.process.artifacts,
  );
  assert.deepEqual(result.result.process.inputs, previousResult.process.inputs);
  assert.deepEqual(input, before);
  assert.deepEqual(mergeAnalysisBatch(input), result);
});

await test("CLV-119 keeps collection order and distinct IDs even when descriptions match", () => {
  const previousResult = accepted(fullCandidate());
  const candidate = extendedBatch();
  const expected = {
    inputs: ["candidate-input", "extra-input"],
    stages: [
      "review",
      "repair",
      "obsolete-approval",
      "historical-post",
      "report",
      "uncertain",
      "interruption",
      "confirmation",
      "extra-repair",
      "extra-stage",
    ],
    branches: ["defect", "extra-branch"],
    loops: ["rounds", "extra-loop"],
    artifacts: ["verified-changes", "extra-artifact"],
    stoppingConditions: ["complete", "exhausted", "extra-stop"],
    gates: ["design", "extra-gate"],
    nonGates: [
      "repair-non-gate",
      "interrupt-non-gate",
      "tool-non-gate",
      "extra-non-gate",
    ],
  };
  candidate.process.stages.reverse();
  candidate.process.stoppingConditions.reverse();
  const result = mergeAnalysisBatch({
    previousResult,
    candidate,
    evidence,
    nextRecordIndex: records.length,
  });
  assert.ok(result.accepted);
  for (const collection of [
    "inputs",
    "stages",
    "branches",
    "loops",
    "artifacts",
    "stoppingConditions",
    "gates",
    "nonGates",
  ] as const)
    assert.deepEqual(
      result.result.process[collection].map((item) => item.id),
      expected[collection],
    );
});

await test("CLV-119 refuses process identity changes and every changed non-reference field", () => {
  const previousResult = accepted(fullCandidate());
  const mutations: readonly [string, string, unknown][] = [
    ["process", "id", "other"],
    ["process", "name", "Other name"],
    ["process", "scope", "Other scope"],
    ["inputs", "description", "Changed input"],
    ["stages", "description", "Changed review"],
    ["stages", "activity", "routine-repair"],
    ["stages", "kind", "exception"],
    ["branches", "condition", "Other condition"],
    ["gates", "type", "factual-input"],
    ["gates", "stageId", "report"],
    ["loops", "stageIds", ["repair", "review"]],
    ["loops", "maxIterations", 4],
    ["loops", "exitCondition", "Other exit"],
    ["loops", "exhaustedStoppingConditionId", "complete"],
    ["stoppingConditions", "description", "Other stop"],
    ["artifacts", "description", "Other artifact"],
    ["nonGates", "reason", "accidental-interruption"],
  ];
  for (const [collection, field, value] of mutations) {
    const candidate = fullCandidate();
    const targets: Record<string, object> = {
      process: candidate.process,
      ...Object.fromEntries(
        Object.entries(candidate.process)
          .filter(([, value]) => Array.isArray(value))
          .map(([key, value]) => [
            key,
            itemAt(Array.isArray(value) ? value : []),
          ]),
      ),
    };
    const target = targets[collection];
    assert.ok(target);
    Reflect.set(target, field, value);
    const input = {
      previousResult,
      candidate,
      evidence,
      nextRecordIndex: records.length,
    };
    const before = structuredClone(input);
    assert.deepEqual(
      mergeAnalysisBatch(input),
      { accepted: false, codes: ["analysis-merge-conflict"] },
      `${collection}.${field}`,
    );
    assert.deepEqual(input, before);
  }
});

await test("CLV-119 refuses ID movement between collections", () => {
  const previousResult = accepted();
  const next = batch();
  for (const id of ["input", "review", "stop"]) {
    const candidate = {
      ...next,
      process: {
        ...next.process,
        inputs: [],
        stages: [{ ...itemAt(next.process.stages), id: "new-review" }],
        stoppingConditions: [{ id: "new-stop", description: "New stop." }],
        artifacts: [{ id, description: "Input." }],
      },
    };
    assert.deepEqual(
      mergeAnalysisBatch({
        previousResult,
        candidate,
        evidence,
        nextRecordIndex: 6,
      }),
      {
        accepted: false,
        codes: ["analysis-merge-conflict"],
      },
    );
  }
});

await test("CLV-119 refuses support or counterevidence beyond the processed prefix", () => {
  for (const field of ["sourceRefs", "counterevidenceRefs"]) {
    const candidate = batch();
    Reflect.set(itemAt(candidate.process.stages), field, [ref(5)]);
    assert.deepEqual(
      mergeAnalysisBatch({
        previousResult: null,
        candidate,
        evidence,
        nextRecordIndex: 5,
      }),
      {
        accepted: false,
        codes: ["unknown-source"],
      },
    );
  }
});

await test("CLV-119 projects only captured processed conflicts without rebuilding redacted classes", () => {
  const redacted = records.map((record) => ({
    ...record,
    text: "redacted collision",
    blocks: [],
  }));
  const candidate = batch();
  const result = mergeAnalysisBatch({
    previousResult: null,
    candidate,
    evidence: { records: redacted, structure },
    nextRecordIndex: 11,
  });
  assert.ok(result.accepted);
  assert.deepEqual(result.result.limitations, {
    historyCompleteness: "unknown",
    independentObservations: "not-established",
    conflictGroups: [{ uuid: "review-one", variants: [[ref(1), ref(10)]] }],
  });
});

await test("CLV-119 rejects invalid processed ranges and mismatched captured identities", () => {
  for (const nextRecordIndex of [
    -1,
    0,
    0.5,
    NaN,
    Infinity,
    records.length + 1,
  ]) {
    assert.deepEqual(
      mergeAnalysisBatch({
        previousResult: null,
        candidate: batch(),
        evidence,
        nextRecordIndex,
      }),
      {
        accepted: false,
        codes: ["analysis-input-refused"],
      },
    );
  }
  const altered = {
    ...evidence,
    records: records.map((record) => ({ ...record, sourceId: "other" })),
  };
  assert.deepEqual(
    mergeAnalysisBatch({
      previousResult: null,
      candidate: batch(),
      evidence: altered,
      nextRecordIndex: 5,
    }),
    {
      accepted: false,
      codes: ["analysis-input-refused"],
    },
  );
});

await test("CLV-119 validates the prior result against the captured prefix", () => {
  const previousResult = accepted(batch([ref(15)]));
  assert.deepEqual(
    mergeAnalysisBatch({
      previousResult,
      candidate: batch(),
      evidence,
      nextRecordIndex: 5,
    }),
    {
      accepted: false,
      codes: ["unknown-source"],
    },
  );
});

await test("CLV-119 retains a validated question as unresolved data rather than silently dropping it", () => {
  const candidate = questionBatch();
  const result = mergeAnalysisBatch({
    previousResult: null,
    candidate,
    evidence,
    nextRecordIndex: 3,
  });
  assert.ok(result.accepted);
  assert.deepEqual(result.result.openQuestion, candidate.openQuestion);
});

await test("CLV-119 refuses a prior unresolved draft as a committed result", () => {
  assert.deepEqual(
    mergeAnalysisBatch({
      previousResult: accepted(questionBatch()),
      candidate: batch(),
      evidence,
      nextRecordIndex: 3,
    }),
    {
      accepted: false,
      codes: ["analysis-input-refused"],
    },
  );
});
