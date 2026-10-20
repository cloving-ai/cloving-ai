import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeAnalysisBatch } from "../src/chats/analysis-merge.ts";
import {
  accepted,
  batch,
  evidence,
  questionBatch,
} from "./chats-analysis-merge-fixture.ts";
import {
  candidate as fullCandidate,
  itemAt,
  records,
  ref,
  structure,
} from "./chats-analysis-fixture.ts";

await test("CLV-119 merges an artifact-only batch and requires complete cumulative collections", () => {
  const previousResult = accepted();
  const next = batch();
  const candidate = {
    ...next,
    process: {
      ...next.process,
      inputs: [],
      stages: [],
      stoppingConditions: [],
      artifacts: [{ id: "artifact", description: "Artifact." }],
    },
  };
  const input = { previousResult, candidate, evidence, nextRecordIndex: 6 };
  const before = structuredClone(input);
  const result = mergeAnalysisBatch(input);
  assert.ok(result.accepted);
  assert.deepEqual(result.result.process, {
    ...previousResult.process,
    artifacts: candidate.process.artifacts,
  });
  assert.deepEqual(input, before);
  assert.deepEqual(mergeAnalysisBatch(input), result);
  assert.deepEqual(mergeAnalysisBatch({ ...input, previousResult: null }), {
    accepted: false,
    codes: ["invalid-shape"],
  });
});

for (const collection of ["branches", "gates"] as const)
  await test(`CLV-119 merges a ${collection}-only batch using prior required collections`, () => {
    const previousResult = accepted(fullCandidate());
    const next = fullCandidate();
    const item = next.process[collection][0];
    assert.ok(item);
    const candidate = {
      ...next,
      process: {
        ...next.process,
        inputs: [],
        stages: [],
        branches: [],
        loops: [],
        artifacts: [],
        stoppingConditions: [],
        gates: [],
        nonGates: [],
        [collection]: [{ ...item, id: "extra" }],
      },
    };
    const result = mergeAnalysisBatch({
      previousResult,
      candidate,
      evidence,
      nextRecordIndex: records.length,
    });
    assert.ok(result.accepted);
    assert.deepEqual(result.result.process, {
      ...previousResult.process,
      [collection]: [
        ...previousResult.process[collection],
        ...candidate.process[collection],
      ],
    });
  });

await test("CLV-119 refuses malformed incoming collections even with a valid prior result", () => {
  for (const collection of ["stages", "stoppingConditions"] as const) {
    for (const value of [null, {}, [null], [{ id: 42 }]]) {
      const candidate = batch();
      Reflect.set(candidate.process, collection, value);
      assert.deepEqual(
        mergeAnalysisBatch({
          previousResult: accepted(),
          candidate,
          evidence,
          nextRecordIndex: 6,
        }),
        { accepted: false, codes: ["invalid-shape"] },
      );
    }
    const candidate = batch();
    Reflect.set(candidate.process, collection, []);
    assert.deepEqual(
      mergeAnalysisBatch({
        previousResult: null,
        candidate,
        evidence,
        nextRecordIndex: 6,
      }),
      { accepted: false, codes: ["invalid-shape"] },
    );
  }
});

await test("CLV-119 revalidates cumulative repetition using original source and copy classes", () => {
  const initial = batch([ref(1), ref(4)]);
  const previousResult = accepted({
    ...initial,
    process: {
      ...initial.process,
      stages: [
        { ...itemAt(initial.process.stages), kind: "observed-repetition" },
      ],
    },
  });
  const next = batch([ref(10)]);
  const candidate = {
    ...next,
    process: {
      ...next.process,
      stages: [{ ...itemAt(next.process.stages), kind: "observed-repetition" }],
    },
  };
  const result = mergeAnalysisBatch({
    previousResult,
    candidate,
    evidence,
    nextRecordIndex: 11,
  });
  assert.ok(result.accepted);
  assert.deepEqual(itemAt(result.result.process.stages).sourceRefs, [
    ref(1),
    ref(4),
    ref(10),
  ]);
  const copies = mergeAnalysisBatch({
    previousResult: null,
    candidate,
    evidence,
    nextRecordIndex: 11,
  });
  assert.deepEqual(copies, { accepted: false, codes: ["copy-only"] });
  const sameSource = batch([ref(11), ref(12)]);
  const repetition = {
    ...sameSource,
    process: {
      ...sameSource.process,
      stages: [
        { ...itemAt(sameSource.process.stages), kind: "observed-repetition" },
      ],
    },
  };
  assert.deepEqual(
    mergeAnalysisBatch({
      previousResult: null,
      candidate: repetition,
      evidence,
      nextRecordIndex: 13,
    }),
    { accepted: false, codes: ["insufficient-repetition"] },
  );
});

await test("CLV-119 cumulative non-gate validation refuses an added gate on prior routine repair", () => {
  const previousResult = accepted(fullCandidate());
  const candidate = fullCandidate();
  candidate.process.gates = [
    { ...itemAt(candidate.process.gates), id: "new-gate", stageId: "repair" },
  ];
  assert.deepEqual(
    mergeAnalysisBatch({
      previousResult,
      candidate,
      evidence,
      nextRecordIndex: records.length,
    }),
    { accepted: false, codes: ["gate-on-non-gate"] },
  );
});

await test("CLV-119 checks new links against cumulative stages rather than the batch alone", () => {
  const previousResult = accepted(fullCandidate());
  const candidate = fullCandidate();
  candidate.process.stages = [itemAt(candidate.process.stages)];
  const result = mergeAnalysisBatch({
    previousResult,
    candidate,
    evidence,
    nextRecordIndex: records.length,
  });
  assert.ok(result.accepted);
  assert.deepEqual(result.result.process, previousResult.process);
});

await test("CLV-119 refuses duplicate IDs and mismatched source identities", () => {
  const next = batch();
  const duplicate = {
    ...next,
    process: {
      ...next.process,
      artifacts: [{ id: "review", description: "Collision." }],
    },
  };
  assert.deepEqual(
    mergeAnalysisBatch({
      previousResult: null,
      candidate: duplicate,
      evidence,
      nextRecordIndex: 3,
    }),
    { accepted: false, codes: ["invalid-shape"] },
  );
  const unknown = batch([{ recordIndex: 1, sourceId: "other" }]);
  assert.deepEqual(
    mergeAnalysisBatch({
      previousResult: null,
      candidate: unknown,
      evidence,
      nextRecordIndex: 3,
    }),
    { accepted: false, codes: ["unknown-source"] },
  );
});

await test("CLV-119 propagates candidate data and shape refusals without exposing private prose", () => {
  for (const [candidate, code] of [
    [null, "invalid-shape"],
    [{ ...batch(), schemaVersion: 2 }, "unknown-version"],
    [{ ...batch(), authority: "PRIVATE" }, "authority-field"],
  ] as const) {
    assert.deepEqual(
      mergeAnalysisBatch({
        previousResult: null,
        candidate,
        evidence,
        nextRecordIndex: 3,
      }),
      { accepted: false, codes: [code] },
    );
  }
  const candidate = Object.defineProperty(batch(), "openQuestion", {
    get: () => {
      throw new Error("PRIVATE");
    },
    enumerable: true,
  });
  assert.deepEqual(
    mergeAnalysisBatch({
      previousResult: null,
      candidate,
      evidence,
      nextRecordIndex: 3,
    }),
    { accepted: false, codes: ["not-plain-data"] },
  );
});

await test("CLV-119 revalidates prior plain data before accessing its process", () => {
  const previousResult = Object.defineProperty(accepted(), "process", {
    get: () => {
      throw new Error("PRIVATE");
    },
    enumerable: true,
  });
  assert.deepEqual(
    mergeAnalysisBatch({
      previousResult,
      candidate: batch(),
      evidence,
      nextRecordIndex: 3,
    }),
    { accepted: false, codes: ["not-plain-data"] },
  );
});

await test("CLV-119 validates question citations against processed captured evidence", () => {
  const candidate = questionBatch();
  candidate.openQuestion.sourceRefs = [ref(1), ref(13)];
  assert.deepEqual(
    mergeAnalysisBatch({
      previousResult: null,
      candidate,
      evidence,
      nextRecordIndex: 3,
    }),
    { accepted: false, codes: ["unknown-source"] },
  );
});

await test("CLV-119 retains cross-batch conflict variants and global record identities", () => {
  const previousResult = accepted();
  const next = batch([ref(13), ref(10)]);
  const candidate = {
    ...next,
    process: {
      ...next.process,
      stages: [
        { ...itemAt(next.process.stages), counterevidenceRefs: [ref(4)] },
      ],
    },
  };
  const result = mergeAnalysisBatch({
    previousResult,
    candidate,
    evidence,
    nextRecordIndex: 14,
  });
  assert.ok(result.accepted);
  assert.deepEqual(
    result.result.limitations.conflictGroups,
    structure.conflictGroups,
  );
  assert.deepEqual(itemAt(result.result.process.stages).sourceRefs, [
    ref(1),
    ref(10),
    ref(13),
  ]);
});
