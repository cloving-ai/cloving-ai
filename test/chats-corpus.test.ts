import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCorpus, validateCoverage } from "../src/chats/corpus-input.ts";
import { coverage, importId, record } from "./chats-redact-fixture.ts";

await test("CLV-103 validates every supported corpus block and preserves metadata and numbers", () => {
  const message = {
    ...record,
    timestamp: "2026-10-17T00:00:00Z",
    sessionId: null,
    blocks: [
      { position: 0, type: "text", text: "synthetic" },
      { position: 2, type: "tool_use", id: "call", name: "tool", input: null },
      {
        position: 3,
        type: "tool_result",
        tool_use_id: "call",
        content: ["synthetic", null, false],
        is_error: true,
      },
      {
        position: 4,
        type: "tool_result",
        tool_use_id: "call",
        content: { number: "NUMBER" },
      },
      {
        position: 5,
        type: "tool_result",
        tool_use_id: "call",
        content: [],
        is_error: false,
      },
    ],
  };
  const text = JSON.stringify(message).replace('"NUMBER"', "9007199254740993");
  assert.equal(JSON.stringify(parseCorpus(text)[0]), text);
  assert.deepEqual(parseCorpus(""), []);
  assert.doesNotThrow(() => {
    validateCoverage(coverage, importId);
  });
});

for (const block of [
  null,
  [],
  { position: 0, type: "text", text: null },
  { position: 0, type: "tool_use", id: 1, name: "tool", input: {} },
  { position: 0, type: "tool_use", id: "call", name: null, input: {} },
  { position: 0, type: "tool_result", tool_use_id: 1, content: "text" },
  { position: 0, type: "tool_result", tool_use_id: "call" },
  {
    position: 0,
    type: "tool_result",
    tool_use_id: "call",
    content: [],
    is_error: null,
  },
]) {
  await test("CLV-103 refuses invalid corpus block fields", () => {
    assert.throws(
      () => parseCorpus(JSON.stringify({ ...record, blocks: [block] })),
      /invalid-import/,
    );
  });
}

for (const message of [
  { ...record, blocks: null },
  { ...record, sourceId: "" },
  {
    ...record,
    blocks: [
      { position: 1, type: "text", text: "first" },
      { position: 1, type: "text", text: "duplicate" },
    ],
  },
  {
    ...record,
    blocks: [
      { position: 2, type: "text", text: "first" },
      { position: 1, type: "text", text: "earlier" },
    ],
  },
]) {
  await test("CLV-103 refuses malformed corpus metadata and block order", () => {
    assert.throws(() => parseCorpus(JSON.stringify(message)), /invalid-import/);
  });
}

await test("CLV-103 refuses malformed JSON and blank corpus records", () => {
  for (const text of ["{", "\n", JSON.stringify(record) + "\n\n"])
    assert.throws(() => parseCorpus(text));
});

const source = {
  path: "/synthetic/transcript",
  status: "included",
  reason: "supported",
  digest: "sha256:synthetic",
  recordCount: 0,
  omissions: { metadataRecords: 0, thinkingBlocks: 0 },
};

const scanCoverage = {
  schemaVersion: 2,
  importId,
  roots: ["/synthetic/root"],
  exclusions: ["skip"],
  limits: {
    depth: 4,
    files: 100,
    sourceBytes: 10_485_760,
    corpusBytes: 52_428_800,
  },
  entries: [
    {
      ...source,
      kind: "file",
      selection: { kind: "file", index: 0 },
      status: "too-large",
      reason: "file-too-large",
      digest: null,
    },
    {
      ...source,
      path: "/synthetic/root/transcript",
      kind: "file",
      selection: { kind: "root", index: 0 },
    },
    {
      ...source,
      path: "/synthetic/root/subtree",
      kind: "subtree",
      selection: { kind: "root", index: 0 },
      status: "excluded",
      reason: "project-excluded",
      digest: null,
    },
    {
      ...source,
      path: "/synthetic/root/subtree",
      kind: "subtree",
      selection: { kind: "root", index: 0 },
      status: "pending",
      reason: "depth-limit",
      digest: null,
    },
  ],
};

await test("CLV-111 accepts version 2 coverage including mixed positional too-large entries", () => {
  assert.doesNotThrow(() => {
    validateCoverage(JSON.stringify(scanCoverage), importId);
  });
});

await test("CLV-111 validates limits by fields and refuses invented records on oversized sources", () => {
  assert.doesNotThrow(() => {
    validateCoverage(
      JSON.stringify({
        ...scanCoverage,
        limits: {
          files: 100,
          corpusBytes: 52_428_800,
          depth: 4,
          sourceBytes: 10_485_760,
        },
      }),
      importId,
    );
  });
  for (const entry of [
    { ...scanCoverage.entries[0], recordCount: 1 },
    { ...scanCoverage.entries[0], digest: "sha256:invented" },
    {
      ...scanCoverage.entries[0],
      omissions: { metadataRecords: 1, thinkingBlocks: 0 },
    },
  ])
    assert.throws(() => {
      validateCoverage(
        JSON.stringify({ ...scanCoverage, entries: [entry] }),
        importId,
      );
    }, /invalid-import/);
});

for (const change of [
  { schemaVersion: 3 },
  { roots: [] },
  { roots: [null] },
  { exclusions: ["../skip"] },
  { limits: { ...scanCoverage.limits, files: 101 } },
  { entries: [null] },
  ...[
    { kind: "unknown" },
    { selection: { kind: "root", index: 1 } },
    { status: "pending", reason: "project-excluded" },
    { status: "excluded", reason: "project-excluded", kind: "file" },
    { status: "too-large", reason: "file-too-large" },
    { reason: "unknown-reason" },
    { recordCount: -1 },
  ].map((entry) => ({
    entries: [
      {
        ...source,
        kind: "file",
        selection: { kind: "root", index: 0 },
        ...entry,
      },
    ],
  })),
]) {
  await test("CLV-111 refuses malformed version 2 coverage and unknown versions", () => {
    assert.throws(() => {
      validateCoverage(
        JSON.stringify({ ...scanCoverage, ...change }),
        importId,
      );
    }, /invalid-import/);
  });
}
for (const file of [
  { ...source, path: null },
  { ...source, reason: null },
  { ...source, status: "future" },
  { ...source, digest: 1 },
  { ...source, recordCount: -1 },
  { ...source, omissions: null },
  { ...source, omissions: { metadataRecords: -1, thinkingBlocks: 0 } },
  { ...source, omissions: { metadataRecords: 0, thinkingBlocks: null } },
]) {
  await test("CLV-103 refuses invalid coverage file entries", () => {
    assert.throws(() => {
      validateCoverage(
        JSON.stringify({ schemaVersion: 1, importId, files: [file] }),
        importId,
      );
    }, /invalid-import/);
  });
}

await test("CLV-103 validates partial coverage without reopening or requiring its source paths", () => {
  assert.doesNotThrow(() => {
    validateCoverage(
      JSON.stringify({
        schemaVersion: 1,
        importId,
        files: [{ ...source, status: "unreadable", digest: null }],
      }),
      importId,
    );
  });
  assert.throws(() => {
    validateCoverage("null", importId);
  }, /invalid-import/);
});

for (const identity of [
  { uuid: " exact ID ", isSidechain: true, parentUuid: null },
  { uuid: "A", isSidechain: false, parentUuid: " parent " },
  { uuid: null, isSidechain: null },
]) {
  await test("CLV-110 accepts version 2 with exact identity and optional parent presence", () => {
    const value = { ...record, schemaVersion: 2, ...identity };
    const text = JSON.stringify(value);
    assert.equal(JSON.stringify(parseCorpus(text)[0]), text);
  });
}

const version2 = { ...record, schemaVersion: 2, uuid: "A", isSidechain: null };
for (const value of [
  { ...record, uuid: "A", isSidechain: null },
  { ...record, parentUuid: null },
  { ...record, schemaVersion: 3 },
  { ...version2, uuid: "" },
  { ...version2, uuid: 3 },
  { ...version2, isSidechain: "true" },
  { ...version2, parentUuid: "" },
  { ...version2, parentUuid: false },
  { ...version2, parentUuid: [] },
  { ...version2, unexpected: "private" },
  { ...record, schemaVersion: 2, uuid: "A" },
  { ...record, schemaVersion: 2, isSidechain: null },
]) {
  await test("CLV-110 refuses malformed identity and version-specific field sets", () => {
    assert.throws(() => parseCorpus(JSON.stringify(value)), /invalid-import/);
  });
}

await test("CLV-111 refuses content states on subtrees and paths outside their selected root", () => {
  for (const entry of [
    {
      ...source,
      path: "/synthetic/root/subtree",
      kind: "subtree",
      selection: { kind: "root", index: 0 },
      status: "unsupported",
      reason: "invalid-json",
      omissions: { metadataRecords: 1, thinkingBlocks: 0 },
    },
    {
      ...source,
      path: "/synthetic/root/subtree",
      kind: "subtree",
      selection: { kind: "root", index: 0 },
      status: "unreadable",
      reason: "source-unreadable",
    },
    {
      ...source,
      path: "/synthetic/root-escape/file.jsonl",
      kind: "file",
      selection: { kind: "root", index: 0 },
    },
    {
      ...source,
      path: "/synthetic/root/../outside.jsonl",
      kind: "file",
      selection: { kind: "root", index: 0 },
    },
  ])
    assert.throws(() => {
      validateCoverage(
        JSON.stringify({ ...scanCoverage, entries: [entry] }),
        importId,
      );
    }, /invalid-import/);
});

function sizedManifests(byteSize: unknown) {
  const size = byteSize === undefined ? {} : { byteSize };
  const legacy: unknown = JSON.parse(coverage);
  assert.ok(legacy && typeof legacy === "object");
  return [
    { ...legacy, files: [{ ...source, ...size }] },
    { ...scanCoverage, entries: [{ ...scanCoverage.entries[0], ...size }] },
  ];
}

await test("CLV-113 accepts legacy and boundary source sizes in both coverage versions", () => {
  for (const byteSize of [0, 10_485_760, undefined]) {
    for (const value of sizedManifests(byteSize))
      assert.doesNotThrow(() => {
        validateCoverage(JSON.stringify(value), importId);
      });
  }
});

await test("CLV-113 refuses invalid optional source sizes in both coverage versions", () => {
  for (const byteSize of [
    -1,
    1.5,
    10_485_761,
    Number.MAX_SAFE_INTEGER,
    null,
    "10",
  ]) {
    for (const value of sizedManifests(byteSize))
      assert.throws(() => {
        validateCoverage(JSON.stringify(value), importId);
      }, /invalid-import/);
  }
});
