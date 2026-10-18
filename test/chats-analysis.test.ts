import assert from "node:assert/strict";
import { test } from "node:test";
import { validateAnalysis } from "../src/chats/analysis.ts";
import {
  candidate,
  itemAt,
  expectedAnnotations,
  records,
  ref,
  structure,
} from "./chats-analysis-fixture.ts";

export function changed(change: (value: ReturnType<typeof candidate>) => void) {
  const value = candidate();
  change(value);
  return value;
}

export function refused(input: unknown, codes: readonly string[]) {
  assert.deepEqual(validateAnalysis(input, { records, structure }), {
    accepted: false,
    codes,
  });
}

await test("CLV-114 accepts the independently annotated bounded loop without granting authority", () => {
  const input = candidate();
  const validation = validateAnalysis(input, { records, structure });
  assert.equal(validation.accepted, true);
  assert.deepEqual(validation.result, {
    ...input,
    limitations: {
      historyCompleteness: "unknown",
      independentObservations: "not-established",
      conflictGroups: structure.conflictGroups,
    },
  });
  const process = validation.result.process;
  assert.deepEqual(
    process.stages.map((stage) => stage.kind),
    expectedAnnotations.kinds,
  );
  assert.deepEqual(
    process.stages.find((stage) => stage.id === "repair")?.sourceRefs,
    expectedAnnotations.repair.sourceRefs,
  );
  assert.deepEqual(
    process.stages.find((stage) => stage.id === "repair")?.counterevidenceRefs,
    expectedAnnotations.repair.counterevidenceRefs,
  );
  assert.deepEqual(
    process.stages.find((stage) => stage.id === "obsolete-approval")
      ?.counterevidenceRefs,
    [ref(9), ref(7)],
  );
  assert.deepEqual(
    process.nonGates.map((item) => [item.stageId, item.reason]),
    expectedAnnotations.nonGates,
  );
  assert.equal(
    process.gates.some((gate) => gate.stageId === "repair"),
    false,
  );
  assert.deepEqual(process.loops[0], {
    id: "rounds",
    description: "Bounded review and repair.",
    kind: "explicit-human-instruction",
    ...expectedAnnotations.loop,
    exitCondition: "Checks and review pass.",
    exhaustedStoppingConditionId: "exhausted",
  });
  assert.equal(
    process.stages.find((stage) => stage.id === "historical-post")?.kind,
    "exception",
  );
  assert.deepEqual(structure.occurrences[10]?.copyOf, ref(1));
  assert.deepEqual(structure.conflictGroups[0]?.variants, [
    [ref(1), ref(10)],
    [ref(13)],
  ]);
  assert.equal(structure.historyCompleteness, "unknown");
});

const wrong = [
  {
    name: "repair approval",
    input: changed((v) => {
      itemAt(v.process.gates, 0).stageId = "repair";
    }),
    codes: ["gate-on-non-gate"],
  },
  {
    name: "publication authority",
    input: changed((v) => {
      Reflect.set(v.process, "publicationAuthority", true);
    }),
    codes: ["authority-field"],
  },
  {
    name: "unmatched source",
    input: changed((v) => {
      itemAt(v.process.stages, 0).sourceRefs = [
        { recordIndex: 1, sourceId: "unmatched" },
      ];
    }),
    codes: ["unknown-source"],
  },
  {
    name: "copy-only support",
    input: changed((v) => {
      itemAt(v.process.stages, 0).sourceRefs = [ref(10)];
    }),
    codes: ["copy-only"],
  },
];
for (const { name, input, codes } of wrong)
  await test(`CLV-114 refuses ${name} with exact fixed codes`, () => {
    refused(input, codes);
  });

const shapeCases = [
  {
    name: "missing support",
    change: (v: ReturnType<typeof candidate>) => {
      Reflect.deleteProperty(itemAt(v.process.stages, 0), "sourceRefs");
    },
    codes: ["missing-source"],
  },
  {
    name: "empty support",
    change: (v: ReturnType<typeof candidate>) => {
      itemAt(v.process.loops, 0).sourceRefs = [];
    },
    codes: ["missing-source"],
  },
  {
    name: "unknown kind",
    change: (v: ReturnType<typeof candidate>) => {
      itemAt(v.process.stages, 0).kind = "invented";
    },
    codes: ["unknown-kind"],
  },
  {
    name: "unknown decision",
    change: (v: ReturnType<typeof candidate>) => {
      itemAt(v.process.gates, 0).type = "invented";
    },
    codes: ["unknown-decision-type"],
  },
  {
    name: "missing limit",
    change: (v: ReturnType<typeof candidate>) => {
      Reflect.deleteProperty(itemAt(v.process.loops, 0), "maxIterations");
    },
    codes: ["invalid-loop-limit"],
  },
  {
    name: "broken branch",
    change: (v: ReturnType<typeof candidate>) => {
      itemAt(v.process.branches, 0).targetStageId = "absent";
    },
    codes: ["invalid-shape"],
  },
  {
    name: "broken loop",
    change: (v: ReturnType<typeof candidate>) => {
      itemAt(v.process.loops, 0).stageIds = ["absent"];
    },
    codes: ["invalid-shape"],
  },
  {
    name: "broken exhaustion",
    change: (v: ReturnType<typeof candidate>) => {
      itemAt(v.process.loops, 0).exhaustedStoppingConditionId = "absent";
    },
    codes: ["invalid-shape"],
  },
  {
    name: "broken gate",
    change: (v: ReturnType<typeof candidate>) => {
      itemAt(v.process.gates, 0).stageId = "absent";
    },
    codes: ["invalid-shape"],
  },
  {
    name: "missing non-gate",
    change: (v: ReturnType<typeof candidate>) => {
      v.process.nonGates.shift();
    },
    codes: ["gate-on-non-gate"],
  },
  {
    name: "wrong non-gate reason",
    change: (v: ReturnType<typeof candidate>) => {
      itemAt(v.process.nonGates, 0).reason = "accidental-interruption";
    },
    codes: ["gate-on-non-gate"],
  },
  {
    name: "missing counterevidence list",
    change: (v: ReturnType<typeof candidate>) => {
      Reflect.deleteProperty(itemAt(v.process.gates, 0), "counterevidenceRefs");
    },
    codes: ["invalid-shape"],
  },
  {
    name: "unknown counterevidence",
    change: (v: ReturnType<typeof candidate>) => {
      Reflect.set(itemAt(v.process.gates), "counterevidenceRefs", [
        { recordIndex: 900, sourceId: "missing" },
      ]);
    },
    codes: ["unknown-source"],
  },
  {
    name: "malformed reference",
    change: (v: ReturnType<typeof candidate>) => {
      itemAt(v.process.stages, 0).sourceRefs = [
        { recordIndex: -1, sourceId: "bad" },
      ];
    },
    codes: ["invalid-shape"],
  },
  {
    name: "duplicate ID",
    change: (v: ReturnType<typeof candidate>) => {
      itemAt(v.process.inputs, 0).id = "repair";
    },
    codes: ["invalid-shape"],
  },
  {
    name: "empty stages",
    change: (v: ReturnType<typeof candidate>) => {
      v.process.stages = [];
    },
    codes: ["invalid-shape"],
  },
  {
    name: "empty stopping conditions",
    change: (v: ReturnType<typeof candidate>) => {
      v.process.stoppingConditions = [];
    },
    codes: ["invalid-shape"],
  },
  {
    name: "extra field",
    change: (v: ReturnType<typeof candidate>) => {
      Reflect.set(v.process, "extra", "secret-candidate-text");
    },
    codes: ["invalid-shape"],
  },
  {
    name: "unknown version",
    change: (v: ReturnType<typeof candidate>) => {
      v.schemaVersion = 2;
    },
    codes: ["unknown-version"],
  },
];
for (const { name, change, codes } of shapeCases)
  await test(`CLV-114 refuses ${name}`, () => {
    refused(changed(change), codes);
  });

for (const maxIterations of [
  0,
  -1,
  1.5,
  Number.MAX_SAFE_INTEGER + 1,
  "3",
  null,
])
  await test(`CLV-114 refuses invalid loop bound ${String(maxIterations)}`, () => {
    refused(
      changed((v) => {
        Reflect.set(itemAt(v.process.loops, 0), "maxIterations", maxIterations);
      }),
      ["invalid-loop-limit"],
    );
  });

for (const type of [
  "design-decision",
  "configured-action-approval",
  "factual-input",
])
  await test(`CLV-114 accepts declared gate type ${type}`, () => {
    assert.equal(
      validateAnalysis(
        changed((v) => {
          itemAt(v.process.gates, 0).type = type;
        }),
        { records, structure },
      ).accepted,
      true,
    );
  });
