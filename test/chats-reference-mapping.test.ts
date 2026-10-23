import assert from "node:assert/strict";
import { test } from "node:test";
import { mapEvidenceReferences } from "../src/chats/reference-mapping.ts";
import { compareEvidence } from "../src/chats/revision.ts";
import {
  firstDigest,
  secondDigest,
  thirdDigest,
  previousImportId,
  currentImportId,
  mapped,
  mappingInput,
  mappingSnapshot,
  selection,
} from "./chats-reference-mapping-fixture.ts";

await test("CLV-120 maps unchanged occurrences by selection and offset without mutating inputs", () => {
  const first = selection("/synthetic/A", { offsets: [0, 40] });
  const second = selection("/synthetic/B");
  const input = mappingInput([first, second], [second, first]);
  const original = structuredClone(input);
  assert.deepEqual(mapEvidenceReferences(input), [
    mapped(0, { currentIndex: 1 }),
    mapped(1, { currentIndex: 2, offset: 40 }),
    mapped(2, { currentIndex: 0 }),
  ]);
  assert.deepEqual(input, original);
});

await test("CLV-120 maps a verified extension only through a complete old record boundary", () => {
  const before = selection("/synthetic/A", { offsets: [0, 40] });
  const after = {
    ...before,
    digest: secondDigest,
    byteSize: 160,
    prefixDigest: firstDigest,
    offsets: [0, 40, 100],
  };
  assert.deepEqual(mapEvidenceReferences(mappingInput([before], [after])), [
    mapped(0, { currentIndex: 0, after: secondDigest }),
    mapped(1, { currentIndex: 1, after: secondDigest, offset: 40 }),
  ]);
});

await test("CLV-120 leaves an extended unterminated final record unmapped even when text and identity repeat", () => {
  const before = selection("/synthetic/A", { offsets: [0, 40] });
  for (const offsets of [
    [0, 40, 101],
    [0, 40],
  ]) {
    const after = {
      ...before,
      digest: secondDigest,
      byteSize: 160,
      prefixDigest: firstDigest,
      offsets,
    };
    assert.deepEqual(mapEvidenceReferences(mappingInput([before], [after])), [
      mapped(0, { currentIndex: 0, after: secondDigest }),
    ]);
  }
});

await test("CLV-120 leaves changed, truncated, missing and new selections unmapped", () => {
  const unchanged = selection("/synthetic/A");
  const changed = selection("/synthetic/B");
  const truncated = selection("/synthetic/C");
  const missing = selection("/synthetic/D");
  const input = mappingInput(
    [unchanged, changed, truncated, missing],
    [
      { ...changed, digest: secondDigest },
      { ...truncated, digest: secondDigest, byteSize: 80 },
      selection("/synthetic/E"),
      unchanged,
    ],
  );
  assert.deepEqual(
    input.revision.map((entry) => entry.status),
    ["changed", "truncated", "new", "unchanged", "missing"],
  );
  assert.deepEqual(mapEvidenceReferences(input), [
    mapped(0, { currentIndex: 3 }),
  ]);
});

await test("CLV-120 resolves each manifest's reordered roots and pairs repeated keys in order", () => {
  const root = "/synthetic";
  const nested = "/synthetic/sub";
  const first = selection("/synthetic/sub/A", { root });
  const second = { ...first, digest: secondDigest };
  const third = { ...first, root: nested, digest: thirdDigest };
  const previous = [first, third, second];
  const current = [third, first, second];
  const input = {
    previous: mappingSnapshot(previousImportId, {
      selections: previous,
      roots: [root, nested],
    }),
    current: mappingSnapshot(currentImportId, {
      selections: current,
      roots: [nested, root],
    }),
    revision: compareEvidence({ previous, current }).entries,
  };
  const original = structuredClone(input);
  assert.deepEqual(mapEvidenceReferences(input), [
    mapped(0, { currentIndex: 1 }),
    mapped(1, { currentIndex: 0, before: thirdDigest }),
    mapped(2, { currentIndex: 2, before: secondDigest }),
  ]);
  assert.deepEqual(input, original);
  const reversed = [second, third, first];
  assert.deepEqual(
    mapEvidenceReferences({
      ...input,
      current: mappingSnapshot(currentImportId, {
        selections: reversed,
        roots: [nested, root],
      }),
      revision: compareEvidence({ previous, current: reversed }).entries,
    }),
    [mapped(1, { currentIndex: 1, before: thirdDigest })],
  );
});

await test("CLV-120 maps provenance even when redacted text and UUIDs differ and keeps exact number tokens", () => {
  const item = selection("/synthetic/A", { byteSize: undefined });
  const input = mappingInput([item], [item]);
  input.previous = {
    ...input.previous,
    corpus: input.previous.corpus.replace(
      '"blocks":[]',
      '"blocks":[{"type":"tool_use","position":0,"id":"synthetic","name":"inert","input":9007199254740993}]',
    ),
  };
  input.current = {
    ...input.current,
    corpus: input.current.corpus
      .replace("synthetic repeated text", "other redaction")
      .replace("repeated-identity", "other-identity"),
  };
  const original = structuredClone(input);
  assert.deepEqual(mapEvidenceReferences(input), [
    mapped(0, { currentIndex: 0 }),
  ]);
  assert.deepEqual(input, original);
  assert.ok(input.previous.corpus.includes("9007199254740993"));
});

await test("CLV-120 refused and subtree selections contribute no corpus range", () => {
  const omitted = selection("/synthetic/omitted", {
    status: "unreadable",
    digest: null,
    offsets: [],
    byteSize: undefined,
    root: "/synthetic",
  });
  const item = selection("/synthetic/A", { root: "/synthetic" });
  const previous = [omitted, item];
  const current = [item, omitted];
  const oldSnapshot = mappingSnapshot(previousImportId, {
    selections: previous,
    roots: ["/synthetic"],
  });
  const newSnapshot = mappingSnapshot(currentImportId, {
    selections: current,
    roots: ["/synthetic"],
  });
  const input = {
    previous: {
      ...oldSnapshot,
      coverage: oldSnapshot.coverage.replace(
        '"kind":"file"',
        '"kind":"subtree"',
      ),
    },
    current: newSnapshot,
    revision: compareEvidence({ previous, current }).entries,
  };
  assert.deepEqual(mapEvidenceReferences(input), [
    mapped(0, { currentIndex: 0 }),
  ]);
});
