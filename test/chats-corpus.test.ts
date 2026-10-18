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
