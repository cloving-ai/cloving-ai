import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compareEvidence,
  pairEvidence,
  type EvidenceSource,
  type RevisionStatus,
} from "../src/chats/revision.ts";

const digest = `sha256:${"a".repeat(64)}`;
const other = `sha256:${"b".repeat(64)}`;
const previous: EvidenceSource = {
  path: "/synthetic/A",
  root: null,
  status: "included",
  digest,
  byteSize: 10,
};

const cases = [
  {
    before: [],
    current: [previous],
    status: "new",
    reason: "no-previous-entry",
  },
  {
    before: [previous],
    current: [],
    status: "missing",
    reason: "not-selected",
  },
  {
    before: [previous],
    current: [{ ...previous, status: "unsupported" }],
    status: "missing",
    reason: "not-included",
  },
  {
    before: [{ ...previous, byteSize: undefined }],
    current: [previous],
    status: "unchanged",
    reason: "same-digest",
  },
  {
    before: [{ ...previous, digest: null }],
    current: [previous],
    status: "changed",
    reason: "previous-digest-unknown",
  },
  {
    before: [{ ...previous, byteSize: undefined }],
    current: [{ ...previous, digest: other, byteSize: 1 }],
    status: "changed",
    reason: "previous-size-unknown",
  },
  {
    before: [previous],
    current: [{ ...previous, digest: other, byteSize: 9 }],
    status: "truncated",
    reason: "shorter-source",
  },
  {
    before: [previous],
    current: [
      { ...previous, digest: other, byteSize: 11, prefixDigest: digest },
    ],
    status: "extended",
    reason: "verified-prefix",
  },
  {
    before: [previous],
    current: [
      { ...previous, digest: other, byteSize: 10, prefixDigest: digest },
    ],
    status: "changed",
    reason: "digest-changed",
  },
  {
    before: [previous],
    current: [
      { ...previous, digest: other, byteSize: 11, prefixDigest: other },
    ],
    status: "changed",
    reason: "digest-changed",
  },
] satisfies {
  before: EvidenceSource[];
  current: EvidenceSource[];
  status: RevisionStatus;
  reason: string;
}[];
await test("CLV-113 compares each evidence rule in priority order", () => {
  for (const item of cases) {
    const result = compareEvidence({
      previous: item.before,
      current: item.current,
    });
    assert.equal(result.entries[0]?.status, item.status);
    assert.equal(result.entries[0].reason, item.reason);
    assert.equal(result.counts[item.status], 1);
    assert.equal(
      Object.values(result.counts).reduce((a, b) => a + b, 0),
      1,
    );
  }
});

await test("CLV-113 pairs by path and root in manifest order and retains unmatched order", () => {
  const b = { ...previous, path: "/synthetic/B" };
  const rooted = { ...previous, root: "/synthetic" };
  const before = [previous, b, { ...previous, digest: other }, rooted];
  const current = [
    b,
    previous,
    previous,
    { ...previous, path: "/synthetic/C" },
  ];
  assert.deepEqual(pairEvidence({ previous: before, current }), [
    1,
    0,
    2,
    null,
  ]);
  const result = compareEvidence({ previous: before, current });
  assert.deepEqual(
    result.entries.map((entry) => [entry.path, entry.root, entry.status]),
    [
      [b.path, null, "unchanged"],
      [previous.path, null, "unchanged"],
      [previous.path, null, "changed"],
      ["/synthetic/C", null, "new"],
      [previous.path, "/synthetic", "missing"],
    ],
  );
  assert.equal(JSON.stringify(result).includes("prefixDigest"), false);
});
