import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCloneReport } from "../../quality/clone-report.ts";

const duplicate = {
  firstFile: { name: "first.ts", start: 1 },
  secondFile: { name: "second.ts", start: 2 },
  tokens: 150,
  lines: 1,
  kind: "exact",
  format: "typescript",
};
const report = {
  duplicates: [duplicate],
  statistics: { total: { clones: 1, sources: 2, tokens: 300, lines: 3 } },
};

await test("QG-14 validates exact lexical clone locations and token count", () => {
  assert.deepEqual(parseCloneReport(report), [
    {
      first: { file: "first.ts", line: 1 },
      second: { file: "second.ts", line: 2 },
      tokens: 150,
    },
  ]);
});

await test("QG-14 permits a valid report with no qualifying clones", () => {
  assert.deepEqual(
    parseCloneReport({
      duplicates: [],
      statistics: { total: { clones: 0, sources: 1, tokens: 5, lines: 1 } },
    }),
    [],
  );
});

for (const [name, value] of [
  ["missing report", undefined],
  ["missing statistics", { duplicates: [] }],
  ["wrong clone count", { ...report, duplicates: [] }],
  [
    "invalid token count",
    { ...report, duplicates: [{ ...duplicate, tokens: 149 }] },
  ],
  [
    "invalid source location",
    {
      ...report,
      duplicates: [{ ...duplicate, firstFile: { name: "first.ts", start: 0 } }],
    },
  ],
  [
    "unexpected semantic mode",
    { ...report, duplicates: [{ ...duplicate, kind: "semantic" }] },
  ],
] as const) {
  await test(`QG-10 rejects ${name}`, () => {
    assert.throws(() => parseCloneReport(value), /clone report/i);
  });
}
