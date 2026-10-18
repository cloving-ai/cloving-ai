import assert from "node:assert/strict";
import { test } from "node:test";
import { structureImport } from "../src/chats/structure.ts";
import { parsePreservedJson } from "../src/chats/normalize.ts";
import type { MessageRecord } from "../src/chats/normalize.ts";

function event(
  uuid: string | null,
  parent: { parentUuid?: string | null } = {},
): Extract<MessageRecord, { schemaVersion: 2 }> {
  return {
    schemaVersion: 2,
    sourceId: "sha256:synthetic:0",
    role: "user",
    timestamp: null,
    sessionId: "S",
    text: "synthetic",
    blocks: [],
    uuid,
    isSidechain: null,
    ...parent,
  };
}

const reference = (recordIndex: number) => ({
  recordIndex,
  sourceId: "sha256:synthetic:0",
});

await test("CLV-110 retains eight occurrences, forks, earliest copies and every conflict variant", () => {
  const original = [
    event("R", { parentUuid: null }),
    event("A", { parentUuid: "R" }),
    { ...event("B", { parentUuid: "R" }), isSidechain: true },
  ];
  const records = [
    ...original,
    ...original,
    { ...event("A", { parentUuid: "R" }), text: "different" },
    event(null),
  ];
  const before = JSON.stringify(records);
  const result = structureImport(records);
  assert.deepEqual(result.counts, {
    records: 8,
    knownSessions: 1,
    forks: 1,
    copies: 3,
    conflictGroups: 1,
    unknownIdentities: 1,
    missingParentTargets: 0,
  });
  assert.deepEqual(
    result.occurrences.map(({ recordIndex, sourceId, copyOf }) => ({
      recordIndex,
      sourceId,
      ...(copyOf ? { copyOf } : {}),
    })),
    records.map((_, recordIndex) => ({
      ...reference(recordIndex),
      ...(recordIndex >= 3 && recordIndex <= 5
        ? { copyOf: reference(recordIndex - 3) }
        : {}),
    })),
  );
  assert.deepEqual(result.conflictGroups, [
    { uuid: "A", variants: [[reference(1), reference(4)], [reference(6)]] },
  ]);
  assert.deepEqual(result.sessions[0]?.forkPoints, [
    { parentUuid: "R", childUuids: ["A", "B"] },
  ]);
  assert.deepEqual(result.sessions[0].unknownParents, [reference(7)]);
  assert.equal(result.occurrences[2]?.isSidechain, true);
  assert.equal(Object.hasOwn(result.occurrences[7] ?? {}, "parentUuid"), false);
  assert.equal(result.historyCompleteness, "unknown");
  assert.equal(
    JSON.stringify(structureImport(records)),
    JSON.stringify(result),
  );
  assert.equal(JSON.stringify(records), before);
  assert.doesNotMatch(
    JSON.stringify(result),
    /synthetic"|different|"text"|"blocks"/,
  );
});

await test("CLV-110 matches identity across sessions without linking sessions or merging unknown sessions", () => {
  const records = [
    event("R", { parentUuid: null }),
    { ...event("A", { parentUuid: "R" }), sessionId: "T" },
    { ...event("R", { parentUuid: null }), sessionId: "T" },
    { ...event("R", { parentUuid: "R" }), sessionId: null },
    { ...event("R", { parentUuid: "R" }), sessionId: "" },
    event("other", { parentUuid: "R" }),
    event(null),
    event(null),
  ];
  const result = structureImport(records);
  assert.equal(result.counts.copies, 3);
  assert.equal(result.counts.knownSessions, 2);
  assert.equal(result.counts.forks, 0);
  assert.deepEqual(result.unknownSessions, [reference(3), reference(4)]);
  assert.deepEqual(result.occurrences[2]?.copyOf, reference(0));
  assert.equal(result.occurrences[5]?.copyOf, undefined);
  assert.equal(result.occurrences[7]?.copyOf, undefined);
  assert.deepEqual(
    result.sessions[0]?.nodes
      .filter((node) => node.uuid === null)
      .map((node) => node.occurrences),
    [[reference(6)], [reference(7)]],
  );
  assert.deepEqual(
    result.sessions[1]?.links.find((link) => link.childUuid === "A"),
    {
      childUuid: "A",
      parentUuid: "R",
      occurrences: [reference(1)],
      status: "resolved",
    },
  );
  const missing = structureImport(records.slice(0, 2));
  assert.deepEqual(missing.sessions[1]?.missingParentTargets, ["R"]);
  assert.equal(missing.counts.missingParentTargets, 1);
  assert.equal(result.historyCompleteness, "unknown");
});

await test("CLV-110 retains unknown parents, missing targets, conflicting parents and cycles", () => {
  const result = structureImport([
    event("R", { parentUuid: null }),
    event("A", { parentUuid: "R" }),
    event("A", { parentUuid: "missing" }),
    event("B", { parentUuid: "R" }),
    event("B", { parentUuid: "R" }),
    event("C", { parentUuid: "D" }),
    event("D", { parentUuid: "C" }),
    event("self", { parentUuid: "self" }),
    event("unknown"),
    event(null, { parentUuid: "missing" }),
  ]);
  const session = result.sessions[0];
  assert.ok(session);
  assert.equal(result.counts.forks, 0);
  assert.deepEqual(session.unknownParents, [reference(8)]);
  assert.deepEqual(session.missingParentTargets, ["missing"]);
  assert.deepEqual(
    session.links
      .filter((link) => link.childUuid === "A")
      .map((link) => link.status),
    ["ambiguous", "ambiguous"],
  );
  assert.equal(session.links.at(-1)?.status, "ambiguous");
  assert.deepEqual(session.cycles, [["C", "D"], ["self"]]);
  assert.equal(
    session.links.filter((link) => link.childUuid === "B").length,
    1,
  );
  const conflict = structureImport([
    event("A", { parentUuid: null }),
    event("A", { parentUuid: "R" }),
    event("R", { parentUuid: "A" }),
  ]);
  assert.deepEqual(conflict.sessions[0]?.cycles, [["A", "R"]]);
  assert.deepEqual(
    conflict.sessions[0].links.map((link) => link.status),
    ["ambiguous", "ambiguous", "resolved"],
  );
});

await test("CLV-110 version 1 has unknown identity and links and empty imports have zero counts", () => {
  const record: MessageRecord = {
    schemaVersion: 1,
    sourceId: "legacy",
    role: "user",
    timestamp: null,
    sessionId: "S",
    text: "synthetic",
    blocks: [],
  };
  const result = structureImport([record, record]);
  assert.equal(result.counts.unknownIdentities, 2);
  assert.equal(result.counts.copies, 0);
  assert.deepEqual(result.sessions[0]?.unknownParents, [
    { recordIndex: 0, sourceId: "legacy" },
    { recordIndex: 1, sourceId: "legacy" },
  ]);
  assert.deepEqual(structureImport([]).counts, {
    records: 0,
    knownSessions: 0,
    forks: 0,
    copies: 0,
    conflictGroups: 0,
    unknownIdentities: 0,
    missingParentTargets: 0,
  });
});

for (const number of [
  "1e400",
  "-1e400",
  "1e-400",
  "9007199254740993",
  "0.1234567890123456789",
  "-0",
]) {
  await test(`CLV-110 compares content without object order and preserves numeric token ${number}`, () => {
    const content = (json: string): MessageRecord => ({
      ...event("ID"),
      blocks: [
        {
          type: "tool_use",
          position: 0,
          id: "call",
          name: "tool",
          input: parsePreservedJson(json),
        },
      ],
    });
    const records = [
      content(`{"x":${number},"y":[1,2]}`),
      content(`{"y":[1,2],"x":${number}}`),
      content(`{"x":"${number}","y":[1,2]}`),
      content(`{"x":${number},"y":[2,1]}`),
      content('{"x":0,"y":[1,2]}'),
    ];
    const before = JSON.stringify(records);
    const result = structureImport(records);
    assert.equal(result.counts.copies, 1);
    assert.equal(result.counts.conflictGroups, 1);
    assert.deepEqual(result.occurrences[1]?.copyOf, reference(0));
    assert.deepEqual(result.conflictGroups[0]?.variants, [
      [reference(0), reference(1)],
      [reference(2)],
      [reference(3)],
      [reference(4)],
    ]);
    assert.equal(JSON.stringify(records), before);
    assert.equal(
      JSON.stringify(structureImport(records)),
      JSON.stringify(result),
    );
  });
}

await test("CLV-110 copy comparison includes role, text and blocks but ignores other metadata", () => {
  const first = event("ID");
  const result = structureImport([
    first,
    {
      ...first,
      sourceId: "other-source",
      timestamp: "later",
      sessionId: "T",
      parentUuid: "different",
      isSidechain: true,
    },
    { ...first, role: "assistant" },
    { ...first, text: "different" },
    { ...first, blocks: [{ position: 0, type: "text", text: "synthetic" }] },
  ]);
  assert.equal(result.counts.copies, 1);
  assert.deepEqual(result.occurrences[1]?.copyOf, reference(0));
  assert.equal(result.conflictGroups[0]?.variants.length, 4);
});

await test("CLV-110 cycle groups retain self-links inside a larger cycle exactly once", () => {
  const result = structureImport([
    event("A", { parentUuid: "B" }),
    event("B", { parentUuid: "A" }),
    event("B", { parentUuid: "B" }),
  ]);
  assert.deepEqual(result.sessions[0]?.cycles, [["A", "B"]]);
});

await test("CLV-110 observes forks at missing parent targets without inventing parent nodes", () => {
  const result = structureImport([
    event("A", { parentUuid: "missing" }),
    event("B", { parentUuid: "missing" }),
  ]);
  assert.equal(result.counts.forks, 1);
  assert.equal(result.counts.missingParentTargets, 1);
  assert.deepEqual(result.sessions[0]?.forkPoints, [
    { parentUuid: "missing", childUuids: ["A", "B"] },
  ]);
  assert.deepEqual(
    result.sessions[0].nodes.map((node) => node.uuid),
    ["A", "B"],
  );
  assert.deepEqual(
    result.sessions[0].links.map((link) => link.status),
    ["missing", "missing"],
  );
});
