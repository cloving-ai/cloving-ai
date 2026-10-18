import assert from "node:assert/strict";
import { test } from "node:test";
import { compareEvidence, type EvidenceSource } from "../src/chats/revision.ts";
import {
  parseEvidenceCoverage,
  nextEvidenceRevision,
} from "../src/chats/revision-input.ts";
import {
  coverage,
  entry,
  importId,
  revision,
} from "./chats-revision-fixture.ts";

await test("CLV-113 decodes legacy coverage and validates earlier selections and digests", () => {
  const result = parseEvidenceCoverage(JSON.stringify(coverage), importId);
  assert.deepEqual(result, [
    {
      path: entry.path,
      root: null,
      status: "included",
      digest: entry.digest,
      byteSize: 10,
    },
  ]);
  for (const change of [
    { path: 1 },
    { path: "relative" },
    { path: "/synthetic/../A" },
    { digest: "invented" },
    { digest: "sha256:a" },
    { byteSize: 10_485_761 },
    { status: "invented" },
  ]) {
    assert.throws(
      () =>
        parseEvidenceCoverage(
          JSON.stringify({ ...coverage, files: [{ ...entry, ...change }] }),
          importId,
        ),
      /invalid-import/,
    );
  }
  assert.equal(
    parseEvidenceCoverage(
      JSON.stringify({
        ...coverage,
        files: [{ ...entry, digest: null, status: "unreadable" }],
      }),
      importId,
    )[0]?.digest,
    null,
  );
});

await test("CLV-113 resolves root indexes against the stored manifest", () => {
  const rootCoverage = {
    schemaVersion: 2,
    importId,
    roots: ["/synthetic/unused", "/synthetic"],
    exclusions: [],
    limits: {
      depth: 4,
      files: 100,
      sourceBytes: 10_485_760,
      corpusBytes: 52_428_800,
    },
    entries: [
      { ...entry, kind: "file", selection: { kind: "root", index: 1 } },
      { ...entry, kind: "file", selection: { kind: "file", index: 4 } },
    ],
  };
  assert.deepEqual(
    parseEvidenceCoverage(JSON.stringify(rootCoverage), importId).map(
      (item) => item.root,
    ),
    ["/synthetic", null],
  );
});

await test("CLV-113 validates whole revision files and refuses invalid revisions or overflow", () => {
  assert.equal(nextEvidenceRevision(undefined, importId), 1);
  assert.equal(nextEvidenceRevision(JSON.stringify(revision), importId), 2);
  for (const change of [
    { schemaVersion: 2 },
    { importId: "different" },
    { previousImportId: importId },
    { previousImportId: "bad" },
    { evidenceRevision: 0 },
    { evidenceRevision: -1 },
    { evidenceRevision: 1.5 },
    { evidenceRevision: Number.MAX_SAFE_INTEGER },
    { evidenceRevision: Number.MAX_SAFE_INTEGER + 1 },
    { counts: {} },
    { entries: [{}] },
    { entries: [{ ...revision.entries[0], reason: "invented" }] },
    { entries: [{ ...revision.entries[0], status: "unchanged" }] },
    { entries: [{ ...revision.entries[0], after: { digest: "invented" } }] },
    { entries: [{ ...revision.entries[0], text: "synthetic" }] },
  ])
    assert.throws(
      () =>
        nextEvidenceRevision(
          JSON.stringify({ ...revision, ...change }),
          importId,
        ),
      /invalid-import/,
    );
});

await test("CLV-113 version 1 entries always stay positional despite legacy extra fields", () => {
  const legacy = {
    ...coverage,
    roots: ["/synthetic"],
    files: [{ ...entry, selection: { kind: "root", index: 0 } }],
  };
  assert.equal(
    parseEvidenceCoverage(JSON.stringify(legacy), importId)[0]?.root,
    null,
  );
});

await test("CLV-113 refuses revision reasons contradicted by stored byte evidence", () => {
  const a = { digest: entry.digest, byteSize: 10 };
  const b = { digest: `sha256:${"b".repeat(64)}`, byteSize: 11 };
  const cases = [
    { reason: "same-digest", status: "unchanged", before: a, after: b },
    {
      reason: "same-digest",
      status: "unchanged",
      before: { digest: null },
      after: { digest: null },
    },
    {
      reason: "previous-digest-unknown",
      status: "changed",
      before: a,
      after: b,
    },
    { reason: "previous-size-unknown", status: "changed", before: a, after: b },
    { reason: "shorter-source", status: "truncated", before: a, after: b },
    { reason: "verified-prefix", status: "extended", before: b, after: a },
    {
      reason: "verified-prefix",
      status: "extended",
      before: { digest: null, byteSize: 0 },
      after: b,
    },
    { reason: "digest-changed", status: "changed", before: a, after: a },
    {
      reason: "digest-changed",
      status: "changed",
      before: a,
      after: { digest: null },
    },
  ];
  for (const change of cases) {
    const counts = {
      new: 0,
      missing: 0,
      unchanged: 0,
      changed: 0,
      truncated: 0,
      extended: 0,
      [change.status]: 1,
    };
    const value = {
      ...revision,
      counts,
      entries: [{ ...revision.entries[0], ...change }],
    };
    assert.throws(
      () => nextEvidenceRevision(JSON.stringify(value), importId),
      /invalid-import/,
    );
  }
});

await test("CLV-113 accepts generated revisions for each evidence reason without rereading bytes", () => {
  const before: EvidenceSource = {
    path: entry.path,
    root: null,
    digest: entry.digest,
    byteSize: 10,
    status: "included",
  };
  const changed = { ...before, digest: `sha256:${"b".repeat(64)}` };
  const inputs = [
    { previous: [], current: [before] },
    { previous: [before], current: [] },
    { previous: [before], current: [{ ...before, status: "unsupported" }] },
    { previous: [before], current: [before] },
    { previous: [{ ...before, digest: null }], current: [changed] },
    { previous: [{ ...before, byteSize: undefined }], current: [changed] },
    { previous: [before], current: [{ ...changed, byteSize: 1 }] },
    {
      previous: [before],
      current: [
        { ...changed, byteSize: 11, prefixDigest: before.digest ?? "" },
      ],
    },
    { previous: [before], current: [changed] },
  ];
  for (const input of inputs)
    assert.equal(
      nextEvidenceRevision(
        JSON.stringify({ ...revision, ...compareEvidence(input) }),
        importId,
      ),
      2,
    );
});

await test("CLV-113 refuses revision selection paths outside their recorded roots", () => {
  for (const root of ["/other", "/synthetic/child", "/synthet"]) {
    const value = { ...revision, entries: [{ ...revision.entries[0], root }] };
    assert.throws(
      () => nextEvidenceRevision(JSON.stringify(value), importId),
      /invalid-import/,
    );
  }
});
