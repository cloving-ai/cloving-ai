import assert from "node:assert/strict";
import { test } from "node:test";
import { validateAnalysis } from "../src/chats/analysis.ts";
import {
  normalizeTranscript,
  type MessageRecord,
} from "../src/chats/normalize.ts";
import { redactRecord } from "../src/chats/redaction.ts";
import {
  structureImport,
  type ImportStructure,
} from "../src/chats/structure.ts";
import {
  candidate,
  records,
  ref,
  structure,
} from "./chats-analysis-fixture.ts";

for (const sourceRefs of [
  [ref(1), ref(1)],
  [ref(1), ref(10)],
  [ref(11), ref(12)],
  [ref(11), ref(11), ref(12)],
])
  await test(`CLV-114 repeated citations and source IDs cannot establish repetition ${JSON.stringify(sourceRefs)}`, () => {
    const input = candidate();
    Reflect.set(input.process.stages[0] ?? {}, "sourceRefs", sourceRefs);
    assert.deepEqual(validateAnalysis(input, { records, structure }), {
      accepted: false,
      codes: ["insufficient-repetition"],
    });
  });

for (const sourceRefs of [
  [ref(1), ref(13)],
  [ref(11), ref(14)],
])
  await test("CLV-114 leaves conflicts and unknown identities uncollapsed without claiming independence", () => {
    const input = candidate();
    Reflect.set(input.process.stages[0] ?? {}, "sourceRefs", sourceRefs);
    assert.equal(
      validateAnalysis(input, { records, structure }).accepted,
      true,
    );
    assert.equal(structure.occurrences[13]?.copyOf, undefined);
    assert.equal(structure.occurrences[11]?.uuid, null);
    assert.equal(structure.historyCompleteness, "unknown");
  });

const mismatches: readonly {
  name: string;
  change: (value: ImportStructure) => void;
}[] = [
  {
    name: "order",
    change: (s) => {
      Reflect.set(s.occurrences[0] ?? {}, "recordIndex", 1);
    },
  },
  {
    name: "source",
    change: (s) => {
      Reflect.set(s.occurrences[0] ?? {}, "sourceId", "wrong");
    },
  },
  {
    name: "UUID",
    change: (s) => {
      Reflect.set(s.occurrences[0] ?? {}, "uuid", "wrong");
    },
  },
  {
    name: "session",
    change: (s) => {
      Reflect.set(s.occurrences[0] ?? {}, "sessionId", "wrong");
    },
  },
  {
    name: "sidechain",
    change: (s) => {
      Reflect.set(s.occurrences[0] ?? {}, "isSidechain", true);
    },
  },
  {
    name: "parent value",
    change: (s) => {
      Reflect.set(s.occurrences[0] ?? {}, "parentUuid", "wrong");
    },
  },
  {
    name: "parent presence",
    change: (s) => {
      Reflect.deleteProperty(s.occurrences[0] ?? {}, "parentUuid");
    },
  },
  {
    name: "occurrence count",
    change: (s) => {
      Reflect.set(s, "occurrences", s.occurrences.slice(1));
    },
  },
  {
    name: "record count",
    change: (s) => {
      Reflect.set(s.counts, "records", 0);
    },
  },
  {
    name: "forward copy",
    change: (s) => {
      Reflect.set(s.occurrences[10] ?? {}, "copyOf", ref(13));
    },
  },
  {
    name: "copy source",
    change: (s) => {
      Reflect.set(s.occurrences[10] ?? {}, "copyOf", {
        recordIndex: 1,
        sourceId: "wrong",
      });
    },
  },
  {
    name: "unknown identity copy",
    change: (s) => {
      Reflect.set(s.occurrences[12] ?? {}, "copyOf", ref(11));
    },
  },
  {
    name: "copy chain",
    change: (s) => {
      Reflect.set(s.occurrences[13] ?? {}, "copyOf", ref(10));
    },
  },
  {
    name: "history completeness",
    change: (s) => {
      Reflect.set(s, "historyCompleteness", "complete");
    },
  },
];
for (const { name, change } of mismatches)
  await test(`CLV-114 refuses structure mismatch: ${name}`, () => {
    const altered = structuredClone(structure);
    change(altered);
    assert.deepEqual(
      validateAnalysis(candidate(), { records, structure: altered }),
      { accepted: false, codes: ["invalid-shape"] },
    );
  });

await test("CLV-114 accepts version 1 evidence without inferring identity", () => {
  const legacy: readonly MessageRecord[] = records.map((record) => ({
    schemaVersion: 1,
    sourceId: record.sourceId,
    role: record.role,
    timestamp: record.timestamp,
    sessionId: record.sessionId,
    text: record.text,
    blocks: record.blocks,
  }));
  assert.equal(
    validateAnalysis(candidate(), {
      records: legacy,
      structure: structureImport(legacy),
    }).accepted,
    true,
  );
});

await test("CLV-114 preserves exact JSON number evidence and never compares redacted content", () => {
  const parsed = normalizeTranscript(
    '{"type":"assistant","uuid":"numeric","message":{"role":"assistant","content":[{"type":"tool_use","id":"tool","name":"tool","input":{"huge":9007199254740993,"negativeZero":-0,"exponent":1e400}}]}}\n',
    "numeric",
  );
  assert.equal(parsed.status, "included");
  const originals = [...records, ...parsed.records];
  const originalStructure = structureImport(originals);
  const redacted = originals.map(
    (record) =>
      redactRecord(record, { home: null, privateTexts: ["Round"] }).record,
  );
  const before = JSON.stringify(redacted);
  const input = candidate();
  Reflect.set(input.process.stages[0] ?? {}, "sourceRefs", [
    { recordIndex: 16, sourceId: "numeric:0" },
    ref(4),
  ]);
  assert.equal(
    validateAnalysis(input, { records: redacted, structure: originalStructure })
      .accepted,
    true,
  );
  assert.equal(JSON.stringify(redacted), before);
  assert.match(before, /9007199254740993/);
  assert.match(before, /"negativeZero":-0/);
  assert.match(before, /1e400/);
});

await test("CLV-114 retains unknown history, conflict groups and the independence limitation", () => {
  const validation = validateAnalysis(candidate(), { records, structure });
  assert.equal(validation.accepted, true);
  assert.deepEqual(Reflect.get(validation.result, "limitations"), {
    historyCompleteness: "unknown",
    independentObservations: "not-established",
    conflictGroups: structure.conflictGroups,
  });
});
