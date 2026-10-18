import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareAnalysisBatch } from "../src/chats/analysis-batches.ts";
import { validateAnalysis } from "../src/chats/analysis.ts";
import { parseCorpus } from "../src/chats/corpus-input.ts";
import { analysisCommand } from "../src/daemon/analysis-launch.ts";
import { emptyCounts } from "../src/chats/redaction.ts";
import { structureImport } from "../src/chats/structure.ts";
import { originalRecords } from "./chats-analysis-fixture.ts";
import { candidate, records, structure } from "./chats-analysis-fixture.ts";

const importId = "11111111-1111-4111-8111-111111111111";
const initial = {
  nextRecordIndex: 0,
  completedBatchCount: 0,
  previousResult: null,
};

await test("CLV-119 accepts escaped evidence that fits the actual launch without an extra wrapper", () => {
  const input = snapshot(['"'.repeat(10_000)]);
  const result = prepareAnalysisBatch(input, initial);
  assert.ok(result.kind === "batch");
  const command = analysisCommand();
  const instruction = command[command.indexOf("--system-prompt") + 1];
  assert.ok(instruction);
  assert.ok(
    Buffer.byteLength(instruction) + Buffer.byteLength(result.prompt) <= 65_536,
  );
  assert.ok(Buffer.byteLength(result.adapterDocument) <= 65_536);
});

function snapshot(texts: readonly string[]) {
  const records = texts.map((text, index) => ({
    ...originalRecords[0],
    schemaVersion: 2 as const,
    sourceId: `synthetic:${String(index)}`,
    uuid: `message-${String(index)}`,
    role: "user" as const,
    sessionId: null,
    isSidechain: null,
    timestamp: null,
    text,
    blocks: [],
  }));
  return {
    importId,
    redaction: JSON.stringify({
      schemaVersion: 1,
      ruleVersion: 1,
      importId,
      recordCount: records.length,
      counts: emptyCounts(),
      totalCount: 0,
    }),
    corpus: records.map((record) => JSON.stringify(record) + "\n").join(""),
    structure: JSON.stringify({
      schemaVersion: 1,
      importId,
      ...structureImport(records),
    }),
  };
}

await test("CLV-119 takes the longest consecutive prefix without splitting records", () => {
  const input = snapshot([
    "a".repeat(24_000),
    "b".repeat(24_000),
    "c".repeat(24_000),
  ]);
  const before = structuredClone(input);
  const result = prepareAnalysisBatch(input, initial);
  assert.ok(result.kind === "batch");
  assert.equal(result.batchIndex, 0);
  assert.equal(result.firstRecordIndex, 0);
  assert.equal(result.nextRecordIndex, 2);
  assert.equal(result.totalRecords, 3);
  assert.equal(
    result.snapshot.corpus,
    input.corpus.split("\n").slice(0, 2).join("\n") + "\n",
  );
  assert.ok(result.launchBytes <= 65_536);
  assert.ok(Buffer.byteLength(result.adapterDocument) <= 65_536);
  assert.deepEqual(input, before);
});

await test("CLV-119 projects captured copy and conflict classes with global indexes", () => {
  const input = snapshot(records.map(() => "redacted collision"));
  input.corpus = records
    .map(
      (record) =>
        JSON.stringify({ ...record, text: "redacted collision", blocks: [] }) +
        "\n",
    )
    .join("");
  input.structure = JSON.stringify({
    schemaVersion: 1,
    importId,
    ...structure,
  });
  const result = prepareAnalysisBatch(input, {
    ...initial,
    nextRecordIndex: 10,
    completedBatchCount: 1,
  });
  assert.ok(result.kind === "batch");
  assert.deepEqual(JSON.parse(result.snapshot.structure), {
    schemaVersion: 1,
    importId,
    historyCompleteness: "unknown",
    occurrences: structure.occurrences.slice(10),
    conflictGroups: structure.conflictGroups,
  });
  assert.deepEqual(structure.occurrences[10]?.copyOf, {
    recordIndex: 1,
    sourceId: "synthetic:1",
  });
});

await test("CLV-119 structure projection excludes every future occurrence and conflict variant", () => {
  const input = snapshot([
    "a".repeat(24_000),
    "b".repeat(24_000),
    "c".repeat(24_000),
  ]);
  const messages = parseCorpus(input.corpus).map((message) => ({
    ...message,
    uuid: "synthetic-conflict",
  }));
  input.corpus = messages
    .map((message) => JSON.stringify(message) + "\n")
    .join("");
  input.structure = JSON.stringify({
    schemaVersion: 1,
    importId,
    ...structureImport(messages),
  });
  const result = prepareAnalysisBatch(input, initial);
  assert.ok(result.kind === "batch");
  assert.deepEqual(JSON.parse(result.snapshot.structure), {
    schemaVersion: 1,
    importId,
    historyCompleteness: "unknown",
    occurrences: structureImport(messages).occurrences.slice(0, 2),
    conflictGroups: [
      {
        uuid: "synthetic-conflict",
        variants: [
          [{ recordIndex: 0, sourceId: "synthetic:0" }],
          [{ recordIndex: 1, sourceId: "synthetic:1" }],
        ],
      },
    ],
  });
});

await test("CLV-119 refuses a fifth batch even when its records fit", () => {
  const input = snapshot(["remaining"]);
  assert.deepEqual(
    prepareAnalysisBatch(input, { ...initial, completedBatchCount: 4 }),
    { kind: "refused", code: "analysis-batch-limit" },
  );
});

await test("CLV-119 refuses invalid positions and exhausted record ranges", () => {
  const input = snapshot(["record"]);
  for (const nextRecordIndex of [-1, 0.5, NaN, Infinity, 1, 2]) {
    assert.deepEqual(
      prepareAnalysisBatch(input, { ...initial, nextRecordIndex }),
      { kind: "refused", code: "analysis-input-refused" },
    );
  }
  for (const completedBatchCount of [-1, 0.5, NaN, Infinity, 5]) {
    assert.deepEqual(
      prepareAnalysisBatch(input, { ...initial, completedBatchCount }),
      { kind: "refused", code: "analysis-input-refused" },
    );
  }
});

await test("CLV-119 returns fixed refusals for invalid evidence without leaking text", () => {
  const input = snapshot(["PRIVATE-SYNTHETIC"]);
  for (const changed of [
    { importId: "../private" },
    { corpus: "PRIVATE-SYNTHETIC" },
    { redaction: "{" },
    { structure: "{}" },
    { corpus: "" },
  ]) {
    assert.deepEqual(prepareAnalysisBatch({ ...input, ...changed }, initial), {
      kind: "refused",
      code: "analysis-input-refused",
    });
  }
});

await test("CLV-119 bounds raw metadata before projecting it", () => {
  const input = snapshot(["record"]);
  for (const field of ["redaction", "structure"] as const) {
    assert.deepEqual(
      prepareAnalysisBatch(
        { ...input, [field]: input[field] + " ".repeat(65_536) },
        initial,
      ),
      { kind: "refused", code: "analysis-too-large" },
    );
  }
});

await test("CLV-119 retains whitespace, line endings and exact JSON number tokens", () => {
  const input = snapshot(["synthetic"]);
  input.corpus = input.corpus
    .replace(
      '"blocks":[]',
      '"blocks":[{"position":0,"type":"tool_use","id":"synthetic","name":"data","input":{"large":9007199254740993,"decimal":1.2300,"exponent":1e400,"negative":-0}}]',
    )
    .replace("{", "{ ")
    .replace("\n", "\r\n");
  const result = prepareAnalysisBatch(input, initial);
  assert.ok(result.kind === "batch");
  assert.equal(result.snapshot.corpus, input.corpus);
  const unterminated = prepareAnalysisBatch(
    { ...input, corpus: input.corpus.trimEnd() },
    initial,
  );
  assert.ok(unterminated.kind === "batch");
  assert.equal(unterminated.snapshot.corpus, input.corpus.trimEnd());
  assert.deepEqual(JSON.parse(result.prompt), {
    evidence: result.snapshot,
    context: { batchIndex: 0, firstRecordIndex: 0, previousResult: null },
  });
});

await test("CLV-119 refuses a corpus above the capture cap before parsing", () => {
  const input = snapshot(["synthetic"]);
  input.corpus = " ".repeat(52_428_801);
  assert.deepEqual(prepareAnalysisBatch(input, initial), {
    kind: "refused",
    code: "analysis-too-large",
  });
});

await test("CLV-119 refuses mismatched manifest counts and captured source identities", () => {
  const input = snapshot(["synthetic"]);
  for (const changed of [
    {
      redaction: input.redaction.replace('"recordCount":1', '"recordCount":2'),
    },
    { structure: input.structure.replace("synthetic:0", "synthetic:other") },
  ]) {
    assert.deepEqual(prepareAnalysisBatch({ ...input, ...changed }, initial), {
      kind: "refused",
      code: "analysis-input-refused",
    });
  }
  Reflect.set(input, "corpus", null);
  assert.deepEqual(prepareAnalysisBatch(input, initial), {
    kind: "refused",
    code: "analysis-input-refused",
  });
});

await test("CLV-119 fits the exact UTF-8 launch boundary including the actual fixed instruction", () => {
  const empty = prepareAnalysisBatch(snapshot([""]), initial);
  assert.ok(empty.kind === "batch");
  const remaining = 65_536 - empty.launchBytes;
  const input = snapshot(["x".repeat(remaining)]);
  const result = prepareAnalysisBatch(input, initial);
  assert.ok(result.kind === "batch");
  assert.equal(result.launchBytes, 65_536);
  const command = analysisCommand();
  const instruction = command[command.indexOf("--system-prompt") + 1];
  assert.ok(instruction);
  assert.equal(
    result.launchBytes,
    Buffer.byteLength(instruction) + Buffer.byteLength(result.prompt),
  );
  assert.deepEqual(
    prepareAnalysisBatch(snapshot(["x".repeat(remaining + 1)]), initial),
    { kind: "refused", code: "analysis-too-large" },
  );
});

await test("CLV-119 counts UTF-8 and repeated JSON escaping before accepting a record", () => {
  for (const text of ["🦊".repeat(17_000), '"\\\t'.repeat(6_000)]) {
    const input = snapshot([text]);
    assert.ok(input.corpus.length < 65_536);
    assert.deepEqual(prepareAnalysisBatch(input, initial), {
      kind: "refused",
      code: "analysis-too-large",
    });
  }
});

await test("CLV-119 carries the earlier accepted result as encoded data and includes its bytes", () => {
  const accepted = validateAnalysis(candidate(), { records, structure });
  assert.ok(accepted.accepted);
  const position = { ...initial, previousResult: accepted.result };
  const result = prepareAnalysisBatch(snapshot(["synthetic"]), position);
  assert.ok(result.kind === "batch");
  assert.deepEqual(JSON.parse(result.prompt), {
    evidence: result.snapshot,
    context: {
      batchIndex: 0,
      firstRecordIndex: 0,
      previousResult: accepted.result,
    },
  });
  const empty = prepareAnalysisBatch(snapshot([""]), initial);
  assert.ok(empty.kind === "batch");
  const input = snapshot(["x".repeat(65_536 - empty.launchBytes)]);
  assert.deepEqual(prepareAnalysisBatch(input, position), {
    kind: "refused",
    code: "analysis-too-large",
  });
});

await test("CLV-119 prepares four ordered batches and leaves the fifth record untouched", () => {
  const input = snapshot(
    Array.from({ length: 5 }, (_, index) => String(index).repeat(40_000)),
  );
  let position = initial;
  const selected: string[] = [];
  for (
    let completedBatchCount = 0;
    completedBatchCount < 4;
    completedBatchCount++
  ) {
    const result = prepareAnalysisBatch(input, position);
    assert.ok(result.kind === "batch");
    assert.equal(result.firstRecordIndex, completedBatchCount);
    assert.equal(result.nextRecordIndex, completedBatchCount + 1);
    selected.push(result.snapshot.corpus);
    position = {
      ...initial,
      nextRecordIndex: result.nextRecordIndex,
      completedBatchCount: completedBatchCount + 1,
    };
  }
  assert.equal(
    selected.join(""),
    input.corpus.split("\n").slice(0, 4).join("\n") + "\n",
  );
  assert.deepEqual(prepareAnalysisBatch(input, position), {
    kind: "refused",
    code: "analysis-batch-limit",
  });
});
