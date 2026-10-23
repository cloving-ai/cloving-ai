import assert from "node:assert/strict";
import { test } from "node:test";
import { mapEvidenceReferences } from "../src/chats/reference-mapping.ts";
import {
  firstDigest,
  secondDigest,
  mappingInput,
  selection,
} from "./chats-reference-mapping-fixture.ts";

const refused = { message: "analysis-reference-map-refused" };

await test("CLV-120 refuses coverage counts that do not partition both corpora", () => {
  const input = mappingInput(
    [selection("/synthetic/A")],
    [selection("/synthetic/A")],
  );
  for (const field of ["previous", "current"] as const) {
    for (const count of [0, 2, -1, 1.5, 9_007_199_254_740_992]) {
      const snapshot = input[field];
      const coverage = snapshot.coverage.replace(
        '"recordCount":1',
        `"recordCount":${String(count)}`,
      );
      assert.throws(
        () =>
          mapEvidenceReferences({
            ...input,
            [field]: { ...snapshot, coverage },
          }),
        refused,
      );
    }
    const snapshot = input[field];
    assert.throws(
      () =>
        mapEvidenceReferences({
          ...input,
          [field]: { ...snapshot, corpus: "" },
        }),
      refused,
    );
    assert.throws(
      () =>
        mapEvidenceReferences({
          ...input,
          [field]: {
            ...snapshot,
            coverage: snapshot.coverage.replace('"included"', '"unreadable"'),
          },
        }),
      refused,
    );
  }
});

await test("CLV-120 validates digest and canonical byte offsets before matching", () => {
  const input = mappingInput(
    [selection("/synthetic/A")],
    [selection("/synthetic/A")],
  );
  const sourceId = `${firstDigest}:0`;
  const invalid = [
    `${secondDigest}:0`,
    `${firstDigest}:00`,
    `${firstDigest}:-1`,
    `${firstDigest}:1.0`,
    `${firstDigest}:1e0`,
    `${firstDigest}:9007199254740992`,
    `${firstDigest}:100`,
    `${firstDigest}:101`,
    `${firstDigest}: 0`,
    `${firstDigest}:0:0`,
    `sha256:${"A".repeat(64)}:0`,
    `sha256:${"a".repeat(63)}:0`,
    "synthetic:0",
  ];
  for (const field of ["previous", "current"] as const) {
    for (const replacement of invalid) {
      const snapshot = input[field];
      assert.throws(
        () =>
          mapEvidenceReferences({
            ...input,
            [field]: {
              ...snapshot,
              corpus: snapshot.corpus.replace(sourceId, replacement),
            },
          }),
        refused,
      );
    }
  }
});

await test("CLV-120 refuses ambiguous, missing and many-to-one occurrences", () => {
  const before = selection("/synthetic/A", { offsets: [0, 40] });
  for (const offsets of [[0, 0], [40, 0], [0, 41], [0], [0, 40, 80]]) {
    const other = { ...before, offsets };
    assert.throws(
      () => mapEvidenceReferences(mappingInput([before], [other])),
      refused,
    );
    assert.throws(
      () => mapEvidenceReferences(mappingInput([other], [before])),
      refused,
    );
  }
});

await test("CLV-120 binds revision entries to both coverage manifests and their order", () => {
  const first = selection("/synthetic/A");
  const second = selection("/synthetic/B", { digest: secondDigest });
  const input = mappingInput([first, second], [first, second]);
  const original = input.revision[0];
  const other = input.revision[1];
  assert.ok(original);
  assert.ok(other);
  const variants = [
    [],
    [other, original],
    [...input.revision, original],
    [{ ...original, path: second.path }, other],
    [{ ...original, before: { digest: secondDigest, byteSize: 100 } }, other],
    [{ ...original, after: { digest: firstDigest, byteSize: 99 } }, other],
    [
      {
        ...original,
        status: "changed" as const,
        reason: "digest-changed" as const,
      },
      other,
    ],
  ];
  for (const revision of variants) {
    assert.throws(() => mapEvidenceReferences({ ...input, revision }), refused);
  }
});

await test("CLV-120 returns a fixed refusal for malformed mapping documents and identities", () => {
  const input = mappingInput(
    [selection("/synthetic/A")],
    [selection("/synthetic/A")],
  );
  for (const field of ["previous", "current"] as const) {
    for (const patch of [
      { coverage: "{" },
      { coverage: "null" },
      { corpus: "{}\n" },
      { importId: "../unsafe" },
      { importId: "" },
      {
        coverage: input[field].coverage.replace(
          '"schemaVersion":1',
          '"schemaVersion":3',
        ),
      },
      { coverage: input[field].coverage.replace(firstDigest, "unknown") },
    ]) {
      assert.throws(
        () =>
          mapEvidenceReferences({
            ...input,
            [field]: { ...input[field], ...patch },
          }),
        refused,
      );
    }
  }
});

await test("CLV-120 refuses equal digests with conflicting sizes and invented prefix records", () => {
  const before = selection("/synthetic/A", { offsets: [0, 40] });
  assert.throws(
    () =>
      mapEvidenceReferences(
        mappingInput([before], [{ ...before, byteSize: 101 }]),
      ),
    refused,
  );
  const after = {
    ...before,
    digest: secondDigest,
    byteSize: 160,
    prefixDigest: firstDigest,
    offsets: [0, 20, 40, 100],
  };
  assert.throws(
    () => mapEvidenceReferences(mappingInput([before], [after])),
    refused,
  );
});
